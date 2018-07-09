import path from 'path';
import querystring from './querystring';
import { each, merge } from 'lodash';
import { NotImplemented, InvalidArgument, UnexpectedValue } from './exceptions';
import { parse } from './xml';
import { empty, tuples, coerce } from './lang';
import models from './models';
import sort from './sort';
import string from './string';
import fetch from 'node-fetch';

const { integer } = coerce;
const P = Promise;
const noop = () => {};
const dummylogger = {log: noop, info: noop};

////////////////////////////////////////////////////////////////////////////////

/**
 * HTTP client
 */
export const Client = class {

  /**
   * Return instance configuration defaults
   * @param void
   * @return {Object}
   */
  defaults () {
    let location = global.location || {
      protocol: 'https:',
      host: 'localhost',
    };

    return {
      language: 'en',

      // these must match your PrestaShop backend languages
      languages: {
        // ISO code => PrestaShop language id
        'en': 1,
      },

      // PrestaShop web service parameters
      webservice: {
        key: 'your-prestashop-key',
        scheme: 'https',
        host: 'your-prestashop-host',
        root: '/api',
      },

      // logger
      logger: dummylogger,

      // Fetch-related options
      fetch: {

        // the actual fetch function; facilitates testing
        algo: fetch,
      },
    };
  }

  /**
   * @param {Object} options
   */
  constructor (options={}) {
    this.options = merge(this.defaults(), options);
    this.fetch = this.options.fetch.algo;
    this.logger = this.options.logger;
    this.funnel = {};
  }

  /**
   * Return a Prestashop API language id
   * @property
   * @type {Number}
   */
  get language () {
    let {languages, language: isocode} = this.options;
    return languages[isocode];
  }

  /**
   * Set the current client language ISO code
   * @param {String} iso
   * @return void
   */
  setLanguageIso (iso) {
    let {languages} = this.options;

    if (!languages.hasOwnProperty(iso)) {
      throw new Error(`language "${iso}" is not configured`);
    }

    this.options.language = iso;
  }

  /**
   * Return the current client language ISO code
   * @param void
   * @return {String}
   */
  getLanguageIso () {
    return this.options.language;
  }

  /**
   * Send a GET request
   * @async Promise
   * @param {String} url
   * @param {Object} query
   * @return {Response}
   */
  get (uri, options={}) {
    let url = this.url(uri, options.query);
    let key = `${this.options.language}:GET:${url}`;
    let funnel = this.funnel;

    // concurrent requests on the same url converge on a single promise
    if (funnel[key]) {
      return funnel[key];
    }

    let fopts = this.createFetchOptions({...options.fetch, method: 'GET'});

    funnel[key] = this.fetch(url, fopts)

    .then((response) => {
      delete funnel[key];
      this.validateResponse(response);
      return response;
    })

    .catch((e) => {
      delete funnel[key];
      throw e;
    })

    return funnel[key];
  }

  /**
   * Return a fully qualified API url
   * @param {String} uri
   * @param {String}
   */
  url (uri, query={}) {
    let qs = '';

    if (!empty(query)) {
      query = tuples(query).sort();
      qs = '?' + querystring.stringify(query);
    }

    if (uri.indexOf('http') === 0) {
      return uri + qs;
    }

    let {webservice} = this.options;
    let fullpath = path.join(webservice.root, uri);

    return `${webservice.scheme}://${webservice.host}${fullpath}${qs}`;
  }

  /**
   * Return node-fetch request options
   * @param {Object} augments
   * @return {Object}
   */
  createFetchOptions (augments={}) {
    return {
      ...this.options.fetch.defaults, 
      headers: this.createHeaders(),
      ...augments,
    };
  }

  /**
   * Return a dictionary containing request headers
   * @param {Object} augments
   * @return {Object}
   */
  createHeaders (augments={}) {
    let {key} = {...this.options.webservice};
    let Authorization = this.createAuthorizationHeader(key);

    return {...augments, Authorization};
  }

  /**
   * @param {Response} response
   * @return void
   * @throws Error
   */
  validateResponse (response) {
    if (!response.ok) {
      throw new UnexpectedValue('got non-2XX HTTP response');
    }
  }

  /**
   * Return an Authorization header value given a web service key
   * @param {String} key
   * @return {String}
   */
  createAuthorizationHeader (key) {
    let username = key;
    let password = '';
    let precursor = `${username}:${password}`;
    let credentials = Buffer.from(precursor).toString('base64');

    return `Basic ${credentials}`;
  }

  /**
   * @param {String} api - snake case form of a resource class name
   * @param {Object} options
   * @return {rest.Resource}
   */
  resource (api, options={}) {
    let classname = string.studly(api);
    let constructor = resources[classname];

    if (!constructor) {
      throw new InvalidArgument(`invalid root resource: "${api}"`);
    }

    return new constructor({
      ...options,
      client: this,
      logger: this.logger,
    });
  }

}

////////////////////////////////////////////////////////////////////////////////
export const resources = {};

/**
 * Resource is an HTTP-aware context that uses a Client to fetch XML payloads
 * from the PrestaShop API. It converts XML payloads into Model instances.
 */
export const Resource = resources.Resource = class {

  /**
   * Return the canonical constructor name. This is a workaround to a side
   * effect of Babel transpilation, which is that Babel mangles class names.
   * @property
   * @type {String}
   */
  static get name () {
    return 'Resource';
  }

  /**
   * Return instance configuration defaults
   * @param void
   * @return {Object}
   */
  defaults () {
    let classname = this.constructor.name;
    let api = string.snake(classname);
    let nodetype = api.slice(0, -1);
    let root = `/${api}`;
    let modelname = classname.slice(0, -1);

    return {
      client: null,
      logger: dummylogger,
      model: models[modelname],
      root: root,
      api: api,
      nodetype: nodetype,

      // model list filter function
      filter: null,

      // model list sort function
      sort: null,
    };
  }

  /**
   * @param {Object} options
   */
  constructor (options={}) {
    this.options = {...this.defaults(), ...options};
    this.client = this.options.client;
    this.logger = this.options.logger; 
  }

  /**
   * Return a PrestaShop language id
   * @property
   * @type {Number}
   */
  get language () {
    return this.client.language;
  }

  /**
   * Resolve an array of Model instances
   * @async Promise
   * @param void
   * @return {Array}
   */
  list (query={}) {
    return this.client.get(this.options.root, {query: query})

    .then((response) => response.clone().text())
    .then((xml) => this.parseModelIds(xml))
    .then((ids) => this.createModels(ids))
    .then((models) => {
      let {sort, filter} = this.options;

      if (filter) {
        models = models.filter(filter);
      }
      if (sort) {
        models = models.sort(sort);
      }

      return models;
    })
  }

  /**
   * Return the first member of a list() result
   * @param void
   * @return {models.Model}
   */
  first () {
    return this.list().then(models => models.shift() || null);
  }

  /**
   * Resolve a single Model instance, or null if there was an error of any kind
   * @async Promise
   * @param {mixed} id
   * @return {Model|null}
   */
  get (id) {
    let uri = `${this.options.root}/${id}`;
    let promise;

    try {
      promise = this.client.get(uri)
    }
    catch (e) {
      this.logger.log(`failed to acquire model properties on request path ${uri}`);
      this.logger.log(e.message);
      this.logger.log(e.stack);

      // FIXME
      return P.resolve(this.createModel());
    }

    return promise.then((response) => response.clone().text())
    .then((xml) => this.parseModelAttributes(xml))
    .then((attrs) => this.createModel(attrs))
  }

  /**
   * Map a list of model ids to model instances.
   * @async Promise
   * @param {Array} ids
   * @return {Array}
   */
  createModels (ids) {
    return P.all(ids.map((id) => this.get(id)));
  }

  /**
   * Given an object containing model properties, return a Model instance.
   * @param {Object} attrs
   * @return {Model}
   */
  createModel (attrs={}) {
    let {model: constructor} = this.options;

    return new constructor({
      client: this.client,
      resource: this,
      attrs: attrs,
    });
  }

  /**
   * Given the API response payload for a list of objects, return a list of
   * model ids.
   * @async Promise
   * @param {String} xml
   * @return {Array}
   */
  parseModelIds (xml) {
    let {api, nodetype} = this.options;
    return parse.model.ids(xml, api, nodetype);
  }

  /**
   * Given the API response payload for a single domain object, return a plain
   * object that contains model properties.
   * @param {String} xml
   * @return {Object}
   */
  parseModelAttributes (xml) {
    let nodetype = this.options.nodetype;
    let ns = parse[nodetype];

    if (!ns) {
      throw new UnexpectedValue(`parser namespace not found on node type ${nodetype}`);
    }
    if (!ns.attributes) {
      throw new UnexpectedValue(`model properties parser not found on node type ${nodetype}`);
    }

    return parse[nodetype].attributes(xml, this.language);
  }

}

resources.Products = class extends Resource {

  /**
   * inheritdoc
   */
  static get name () {
    return 'Products';
  }
}

resources.Images = class extends Resource {

  static get name () {
    return 'Images';
  }

  /**
   * @inheritdoc
   */
  list () {
    return this.client.get(this.options.root)
    .then((response) => response.clone().text())
    .then((xml) => this.parseImageAttributes(xml))
    .then((attrsets) => attrsets.map((attrs) => this.createModel(attrs)))
  }

  /**
   * Return a list of urls given an XML payload
   * @async Promise
   * @param {String} xml
   * @return {Array}
   */
  parseImageAttributes (xml) {
    return parse.image.attributes(xml);
  }
}


resources.Manufacturers = class extends Resource {

  /**
   * @inheritdoc
   */
  static get name () {
    return 'Manufacturers';
  }
}

resources.Combinations = class extends Resource {

  /**
   * @inheritdoc
   */
  static get name () {
    return 'Combinations';
  }
}

resources.StockAvailables = class extends Resource {

  /**
   * @inheritdoc
   */
  static get name () {
    return 'StockAvailables';
  }
}

resources.ProductOptionValues = class extends Resource {

  /**
   * inheritdoc
   */
  static get name () {
    return 'ProductOptionValues';
  }

  /**
   * @inheritdoc
   */
  defaults () {
    return {
      ...super.defaults(),
      sort: sort.ascending(model => model.position),
    };
  }
}


export default { Client, resources };
