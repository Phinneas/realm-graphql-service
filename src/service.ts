import { ExpressHandler, graphiqlExpress, graphqlExpress } from 'apollo-server-express';
import * as express from 'express';
import { buildSchema, execute, GraphQLError, GraphQLSchema, subscribe } from 'graphql';
import { PubSub, withFilter } from 'graphql-subscriptions';
import { makeExecutableSchema } from 'graphql-tools';
import { IResolverObject } from 'graphql-tools/dist/Interfaces';
import * as LRU from 'lru-cache';
import * as pluralize from 'pluralize';
import { ObjectSchema, ObjectSchemaProperty } from 'realm';
import {
    AccessToken,
    BaseRoute,
    errors,
    Get,
    Post,
    Promisify,
    Request,
    Response,
    Server,
    ServerStarted,
    ServerStartParams,
    Stop,
    Token,
    TokenValidator,
    Upgrade
} from 'realm-object-server';
import { SubscriptionServer } from 'subscriptions-transport-ws';
import { setTimeout } from 'timers';

interface SchemaTypes {
  type: string;
  inputType: string;
}

interface PKInfo {
  name: string;
  type: string;
}

interface PropertySchemaInfo {
  propertySchema: string;
  inputPropertySchema: string;
  pk: PKInfo;
}

interface SubscriptionDetails {
  results: Realm.Results<{}>;
  realm: Realm;
}

/**
 * Settings to control the [[GraphQLService]] behavior.
 */
export interface GraphQLServiceSettings {
  /**
   * Settings controlling the schema caching strategy. If set to `'NoCache'`,
   * Realm schemas will not be cached and instead generated on every request.
   * This is useful while developing and schemas may change frequently, but
   * drastically reduces performance. If not set, or set to a [[SchemaCacheSettings]]
   * instance, schemas will be cached.
   */
  schemaCacheSettings?: SchemaCacheSettings | 'NoCache';

  /**
   * Disables authentication for graphql endpoints. This may be useful when
   * you are developing the app and want a more relaxed exploring experience.
   * If you're using studio to explore the graphql API and responses, it will
   * handle authentication for you, so there's no need to disable it.
   */
  disableAuthentication?: boolean;

  /**
   * Disables the grahpiql explorer endpoint (`/grahpql/explore`).
   */
  disableExplorer?: boolean;

  /**
   * The number in milliseconds which a Realm will be kept open after a request
   * has completed. Higher values mean that more Realms will be kept in the cache,
   * drastically improving the response times of requests hitting "warm" Realms.
   * This, however, comes at the cost of increased memory usage. Default is
   * 120000 (2 minutes).
   */
  realmCacheMaxAge?: number;
}

/**
 * Settings controlling the schema caching strategy.
 */
export interface SchemaCacheSettings {
  /**
   * The number of schemas to keep in the cache. Default is 1000.
   */
  max?: number;

  /**
   * The max age for schemas in cache. Default is infinite.
   */
  maxAge?: number;
}

/**
 * A service that exposes a GraphQL API for accessing the Realm files.
 * Create a new instance and pass it to `BasicServer.addService` before
 * calling `BasicServer.start`
 *
 * @example
 * ```
 *
 * const service = new GraphQLService({
 *   // Enable schema caching to improve performance
 *   schemaCacheSettings: {}
 * });
 *
 * server.addService(service);
 *
 * server.start();
 * ```
 */
@BaseRoute('/graphql')
export class GraphQLService {
  private server: Server;
  private subscriptionServer: SubscriptionServer;
  private handler: ExpressHandler;
  private graphiql: ExpressHandler;
  private pubsub: PubSub;
  private querysubscriptions: { [id: string]: SubscriptionDetails } = {};
  private schemaCache: LRU.Cache<string, GraphQLSchema>;
  private realmCacheTTL: number;
  private disableAuthentication: boolean;
  private disableExplorer: boolean;

  /**
   * Creates a new `GraphQLService` instance.
   * @param settings Settings, controlling the behavior of the service related
   * to caching and authentication.
   */
  constructor(settings?: GraphQLServiceSettings) {
    settings = settings || {};

    if (settings.schemaCacheSettings !== 'NoCache') {
      this.schemaCache = new LRU({
        max: (settings.schemaCacheSettings && settings.schemaCacheSettings.max) || 1000,
        maxAge: settings.schemaCacheSettings && settings.schemaCacheSettings.maxAge
      });
    }

    this.disableAuthentication = settings.disableAuthentication || false;
    this.disableExplorer = settings.disableExplorer || false;
    this.realmCacheTTL = settings.realmCacheMaxAge || 120000;
  }

  @ServerStarted()
  private serverStarted(server: Server) {
    this.server = server;
    this.pubsub = new PubSub();

    const runningParams: ServerStartParams = (this.server as any).runningParams;

    this.subscriptionServer = new SubscriptionServer(
      {
        schema: buildSchema('type Query{\nfoo:Int\n}'),
        execute: async (_, document, root, context, variables, operationName) => {
          const schema = await this.updateSubscriptionSchema(context);
          return execute(schema, document, root, context, variables, operationName);
        },
        subscribe: async (_, document, root, context, variables, operationName) => {
          const schema = await this.updateSubscriptionSchema(context);
          return subscribe(schema, document, root, context, variables, operationName);
        },
        onOperationComplete: (socket, opid) => {
          const details = this.querysubscriptions[opid];
          if (details) {
            details.results.removeAllListeners();
            setTimeout(() => details.realm.close(), this.realmCacheTTL);
            delete this.querysubscriptions[opid];
          }
        },
        onOperation: (message, params, socket) => {
          params.context.operationId = message.id;

          // HACK: socket.realmPath is set in subscriptionHandler to the
          // :path route parameter
          params.context.realmPath = socket.realmPath;
          return params;
        },
        onConnect: async (authPayload, socket) => {
          let accessToken: Token;
          if (!this.disableAuthentication) {
            if (!authPayload || !authPayload.token) {
              throw new errors.realm.MissingParameters('Missing \'connectionParams.token\'.');
            }

            accessToken = this.server.tokenValidator.parse(authPayload.token);
            this.authenticate(accessToken, socket.realmPath);
          }

          return {
            accessToken
          };
        }
      },
      {
        noServer: true
      }
    );

    this.handler = graphqlExpress(async (req, res) => {
      const path = req.params.path;
      const realm = await this.server.openRealm(path);
      const schema = this.getSchema(path, realm);

      res.once('finish', () => {
        setTimeout(() => realm.close(), this.realmCacheTTL);
      });

      return {
        schema,
        context: {
          realm,
          accessToken: (req as any).authToken
        }
      };
    });

    this.graphiql = graphiqlExpress((req) => {
      const path = req.params.path;

      const protocol = req.protocol === 'https' ? 'wss' : 'ws';

      const result: any = {
        endpointURL: `/graphql/${encodeURIComponent(path)}`,
        subscriptionsEndpoint: `${protocol}://${req.get('host')}/graphql/${encodeURIComponent(path)}`
      };

      const token = req.get('authorization');
      if (token) {
        result.passHeader = `'Authorization': '${token}'`;
        result.websocketConnectionParams = { token };
      }

      return result;
    });
  }

  @Stop()
  private stop() {
    this.subscriptionServer.close();
  }

  @Upgrade('/:path')
  private async subscriptionHandler(req, socket, head) {
    const wsServer = this.subscriptionServer.server;
    const ws = await new Promise<any>((resolve) => wsServer.handleUpgrade(req, socket, head, resolve));

    // HACK: we're putting the realmPath on the socket client
    // and resolving it in subscriptionServer.onOperation to
    // populate it in the subscription context.
    ws.realmPath = req.params.path;
    wsServer.emit('connection', ws, req);
  }

  @Get('/explore/:path')
  private getExplore(@Request() req: express.Request, @Response() res: express.Response) {
    if (this.disableExplorer) {
      throw new errors.realm.AccessDenied();
    }

    this.authenticate((req as any).authToken, req.params.path);
    this.graphiql(req, res, null);
  }

  @Post('/explore/:path')
  private postExplore(@Request() req: express.Request, @Response() res: express.Response) {
    if (this.disableExplorer) {
      throw new errors.realm.AccessDenied();
    }

    this.authenticate((req as any).authToken, req.params.path);
    this.graphiql(req, res, null);
  }

  @Get('/:path')
  private get(@Request() req: express.Request, @Response() res: express.Response) {
    this.authenticate((req as any).authToken, req.params.path);
    this.handler(req, res, null);
  }

  @Post('/:path')
  private post(@Request() req: express.Request, @Response() res: express.Response) {
    this.authenticate((req as any).authToken, req.params.path);
    this.handler(req, res, null);
  }

  private authenticate(authToken: any, path: string) {
    if (this.disableAuthentication) {
      return;
    }

    if (!authToken) {
      throw new errors.realm.AccessDenied('Authorization header is missing.');
    }

    const accessToken = authToken as AccessToken;
    if (accessToken.path !== path && !accessToken.isAdminToken()) {
      throw new errors.realm.InvalidCredentials('The access token doesn\'t grant access to the requested path.');
    }
  }

  private validateAccess(context: any, access: string) {
    if (this.disableAuthentication) {
      return;
    }

    const token = context.accessToken as AccessToken;
    if (!token ||  !token.access || token.access.indexOf(access) < 0) {
      throw new errors.realm.InvalidCredentials({
        title: `The current user doesn\'t have '${access}' access.`
      });
    }
  }

  private validateRead(context: any) {
    this.validateAccess(context, 'download');
  }

  private validateWrite(context: any) {
    this.validateAccess(context, 'upload');
  }

  private getSchema(path: string, realm: Realm): GraphQLSchema {
    if (this.schemaCache && this.schemaCache.has(path)) {
      return this.schemaCache.get(path);
    }

    let schema = '';
    const types = new Array<[string, PKInfo]>();
    const queryResolver: IResolverObject = {};
    const mutationResolver: IResolverObject = {};
    const subscriptionResolver: IResolverObject = {};

    for (const obj of realm.schema) {
      const propertyInfo = this.getPropertySchema(obj);

      types.push([obj.name, propertyInfo.pk]);

      schema += `type ${obj.name} { \n${propertyInfo.propertySchema}}\n\n`;
      schema += `input ${obj.name}Input { \n${propertyInfo.inputPropertySchema}}\n\n`;
    }

    let query = 'type Query {\n';
    let mutation = 'type Mutation {\n';
    let subscription = 'type Subscription {\n';

    for (const [type, pk] of types) {
      // TODO: this assumes types are PascalCase
      const camelCasedType = this.camelcase(type);
      const pluralType = pluralize(camelCasedType);

      query += this.setupGetAllObjects(queryResolver, type, pluralType);
      mutation += this.setupAddObject(mutationResolver, type);
      mutation += this.setupDeleteObjects(mutationResolver, type);
      subscription += this.setupSubscribeToQuery(subscriptionResolver, type, pluralType);

      // If object has PK, we add get by PK and update option.
      if (pk) {
        query += this.setupGetObjectByPK(queryResolver, type, camelCasedType, pk);
        mutation += this.setupUpdateObject(mutationResolver, type);
        mutation += this.setupDeleteObject(mutationResolver, type, pk);
      }
    }

    query += '}\n\n';
    mutation += '}\n\n';
    subscription += '}';

    schema += query;
    schema += mutation;
    schema += subscription;

    const result = makeExecutableSchema({
      typeDefs: schema,
      resolvers: {
        Query: queryResolver,
        Mutation: mutationResolver,
        Subscription: subscriptionResolver
      },
    });

    if (this.schemaCache) {
      this.schemaCache.set(path, result);
    }

    return result;
  }

  private setupGetAllObjects(queryResolver: IResolverObject, type: string, pluralType: string): string {
    queryResolver[pluralType] = (_, args, context) => {
      this.validateRead(context);

      let result: any = context.realm.objects(type);
      if (args.query) {
        result = result.filtered(args.query);
      }

      if (args.sortBy) {
        const descending = args.descending || false;
        result = result.sorted(args.sortBy, descending);
      }

      return this.slice(result, args);
    };

    // TODO: limit sortBy to only valid properties
    return `${pluralType}(query: String, sortBy: String, descending: Boolean, skip: Int, take: Int): [${type}!]\n`;
  }

  private setupAddObject(mutationResolver: IResolverObject, type: string): string {
    mutationResolver[`add${type}`] = (_, args, context) => {
      this.validateWrite(context);

      let result: any;
      context.realm.write(() => {
        result = context.realm.create(type, args.input);
      });

      return result;
    };

    return `add${type}(input: ${type}Input): ${type}\n`;
  }

  private setupSubscribeToQuery(subscriptionResolver: IResolverObject, type: string, pluralType: string): string {
    subscriptionResolver[pluralType] = {
      subscribe: (_, args, context) => {
        this.validateRead(context);

        const realm: Realm = context.realm;
        let result = realm.objects(type);
        if (args.query) {
          result = result.filtered(args.query);
        }

        if (args.sortBy) {
          const descending = args.descending || false;
          result = result.sorted(args.sortBy, descending);
        }

        const opId = context.operationId;
        this.querysubscriptions[opId] = {
          results: result,
          realm
        };

        result.addListener((collection, change) => {
          const payload = {};
          payload[pluralType] = this.slice(collection, args);
          this.pubsub.publish(opId, payload);
        });

        return this.pubsub.asyncIterator(opId);
      }
    };

    // TODO: limit sortBy to only valid properties
    return `${pluralType}(query: String, sortBy: String, descending: Boolean, skip: Int, take: Int): [${type}!]\n`;
  }

  private setupGetObjectByPK(queryResolver: IResolverObject, type: string, camelCasedType: string, pk: PKInfo): string {
    queryResolver[camelCasedType] = (_, args, context) => {
      this.validateRead(context);

      return context.realm.objectForPrimaryKey(type, args[pk.name]);
    };
    return `${camelCasedType}(${pk.name}: ${pk.type}): ${type}\n`;
  }

  private setupUpdateObject(mutationResolver: IResolverObject, type: string): string {
    // TODO: validate that the PK is set
    // TODO: validate that object exists, otherwise it's addOrUpdate not just update
    mutationResolver[`update${type}`] = (_, args, context) => {
      this.validateWrite(context);

      let result: any;
      context.realm.write(() => {
        result = context.realm.create(type, args.input, true);
      });

      return result;
    };

    return `update${type}(input: ${type}Input): ${type}\n`;
  }

  private setupDeleteObject(mutationResolver: IResolverObject, type: string, pk: PKInfo): string {
    mutationResolver[`delete${type}`] = (_, args, context) => {
      this.validateWrite(context);

      let result: boolean = false;
      context.realm.write(() => {
        const obj = context.realm.objectForPrimaryKey(type, args[pk.name]);
        if (obj) {
          context.realm.delete(obj);
          result = true;
        }
      });

      return result;
    };

    return `delete${type}(${pk.name}: ${pk.type}): Boolean\n`;
  }

  private setupDeleteObjects(mutationResolver: IResolverObject, type: string): string {
    const pluralType = pluralize(type);

    mutationResolver[`delete${pluralType}`] = (_, args, context) => {
      this.validateWrite(context);

      const realm: Realm = context.realm;
      let result: number;
      realm.write(() => {
        let toDelete = realm.objects(type);
        if (args.query) {
          toDelete = toDelete.filtered(args.query);
        }

        result = toDelete.length;
        realm.delete(toDelete);
      });

      return result;
    };

    return `delete${pluralType}(query: String): Int\n`;
  }

  private async updateSubscriptionSchema(context: any): Promise<GraphQLSchema> {
    const path = context.realmPath;
    if (!path) {
      throw new GraphQLError('Missing "realmPath" from context. It is required for subscriptions.');
    }
    const realm = await this.server.openRealm(path);
    const schema = this.getSchema(path, realm);

    context.realm = realm;

    return schema;
  }

  private getPropertySchema(obj: ObjectSchema): PropertySchemaInfo {
    let schemaProperties = '';
    let inputSchemaProperties = '';
    let primaryKey: PKInfo = null;

    for (const key in obj.properties) {
      if (!obj.properties.hasOwnProperty(key)) {
        continue;
      }

      const prop = obj.properties[key] as ObjectSchemaProperty;
      if (prop.type === 'linkingObjects') {
        continue;
      }

      const types = this.getTypeString(prop);

      schemaProperties += `${key}: ${types.type}\n`;
      inputSchemaProperties += `${key}: ${types.inputType}\n`;

      if (key === obj.primaryKey) {
        primaryKey = {
          name: key,
          type: types.type
        };
      }
    }

    return {
      propertySchema: schemaProperties,
      inputPropertySchema: inputSchemaProperties,
      pk: primaryKey
    };
  }

  private getTypeString(prop: ObjectSchemaProperty): SchemaTypes {
    let type: string;
    let inputType: string;
    switch (prop.type) {
      case 'object':
        type = prop.objectType;
        inputType = `${prop.objectType}Input`;
        break;
      case 'list':
        const innerType = this.getPrimitiveTypeString(prop.objectType, prop.optional);
        type = `[${innerType}]`;

        switch (prop.objectType) {
          case 'bool':
          case 'int':
          case 'float':
          case 'double':
          case 'date':
          case 'string':
          case 'data':
            inputType = type;
            break;
          default:
            inputType = `[${innerType}Input]`;
            break;
        }
        break;
      default:
        type = this.getPrimitiveTypeString(prop.type, prop.optional);
        inputType = this.getPrimitiveTypeString(prop.type, true);
        break;
    }

    return {
      type,
      inputType
    };
  }

  private getPrimitiveTypeString(prop: string, optional: boolean): string {
    let result = '';
    switch (prop) {
      case 'bool':
        result = 'Boolean';
        break;
      case 'int':
        result = 'Int';
        break;
      case 'float':
      case 'double':
        result = 'Float';
        break;
      case 'date':
      case 'string':
      case 'data':
        result = 'String';
        break;
      default:
        return prop;
    }

    if (!optional) {
      result += '!';
    }

    return result;
  }

  private slice(collection: any, args: { [key: string]: any }): any {
    if (args.skip || args.take) {
      const skip = args.skip || 0;
      if (args.take) {
        return collection.slice(skip, args.take + skip);
      }

      return collection.slice(skip);
    }

    return collection;
  }

  private camelcase(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
  }
}
