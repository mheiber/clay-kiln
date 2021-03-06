import _ from 'lodash';

var dom = require('@nymag/dom'),
  cache = require('./cache'),
  db = require('./db'),
  promise = require('../promises'),
  references = require('../references'),
  site = require('./../site'),
  progress = require('../progress'),
  label = require('../label'),
  queue = require('./queue'),
  refProp = references.referenceProperty,
  pagesRoute = '/pages/',
  urisRoute = '/uris/',
  scheduleRoute = '/schedule',
  schemaKeywords = ['_ref', '_groups', '_description'],
  knownExtraFields = ['_ref', '_schema'],
  bannedFields = ['_self', '_components', '_pageRef', '_pageData', '_version', '_refs', 'layout', 'template'],
  hbs = require('nymag-handlebars')(),
  pt = require('promise-timeout'),
  MODEL_TIMEOUT = 500;

// add precompiled templates as partials (on page load)
document.addEventListener('DOMContentLoaded', function () {
  const templates = _.get(window, 'kiln.services.componentTemplates');

  if (_.isObject(templates) && !_.isEmpty(templates)) {
    _.forOwn(templates, function (tpl, name) {
      hbs.registerPartial(name, hbs.template(tpl));
    });
  }
});

/**
 * Cloning removes extra properties like _schema from standard types like Array, because we're doing a bad thing.
 *
 * This function adds them back.
 *
 * @param {object} data
 * @returns {object}
 */
function addDeviantArraySchemas(data) {
  _.each(data._schema, function (fieldDefinition, fieldName) {
    var value = data[fieldName];

    if (_.isArray(value)) {
      value._schema = fieldDefinition;
    }
  });
  return data;
}

/**
 * Do validation
 *
 * @param {object} data
 * @param {schema} schema
 * @returns {Array}
 */
function validate(data, schema) {
  var errors = [],
    uri = data[refProp],
    keys = Object.keys(data),
    groupFields = schema._groups && Object.keys(schema._groups) || [],
    fields = Object.keys(schema).concat(knownExtraFields).concat(groupFields),
    foundBannedFields = _.intersection(bannedFields, keys),
    unknownFields = _.filter(keys, function (key) { return !_.includes(fields, key); });

  if (!uri) {
    errors.push(new Error('Cannot save data without ' + refProp));
  }

  if (foundBannedFields.length) {
    errors.push(new Error('Banned fields found in data: ' + foundBannedFields.toString()));
  }

  if (unknownFields.length) {
    // todo: we need to decide:

    // be forgiving; they meant well
    _.each(unknownFields, function (unknownField) {
      delete data[unknownField];
    });

    // unforgiving: errors.push(new Error('Unknown fields found in data: ' + unknownFields.toString()));
  }

  // block unusual formatting of data (so the errors_for saving past this point are consistent)
  _.each(fields, function (fieldName) {
    var str,
      value = data[fieldName];

    // everything that is not a schemaKeyword must be object-like (object, array, etc.)
    if (!_.includes(schemaKeywords, fieldName) && typeof value !== 'object') {
      str = 'Amphora-style data (raw value) found in ' + fieldName + '; please use ClayKiln style (value, _schema) instead.';
      errors.push(new Error(str));
    }
  });

  return errors;
}

/**
 * save and re-render on the client-side
 * @param  {string} uri
 * @param  {object} data
 * @return {Promise} with re-rendered element
 */
function clientSave(uri, data) {
  // testing fully-client-side rerender
  const name = references.getComponentNameFromReference(uri),
    model = window.kiln.services.componentModels[_.camelCase(name)],
    tpl = hbs.template(window.kiln.services.componentTemplates[name]);

  return cache.removeExtras(uri, data)
    .then(function (cleanData) {
      return pt.timeout(Promise.resolve(model.save(uri, cleanData)), MODEL_TIMEOUT);
    })
    .then(function (finalData) {
      queue.add(db.save, [uri, finalData, false]); // do this in the background
      finalData._ref = uri; // add uri AFTER doing db.save
      // add new data to cache
      // control.setReadOnly(finalData);
      cache.getData.cache = new _.memoize.Cache();
      cache.getDataOnly.cache = new _.memoize.Cache();
      cache.getDataOnly.cache.set(uri, finalData);
      cache.getData(uri); // warm the cache with new data
      return finalData;
    })
    .then(function (cachedData) {
      // todo: add more locals and stuff when we use a full redux store
      let locals = {
          edit: true,
          site: {
            host: site.get('host'),
            path: site.get('path'),
            assetPath: site.get('assetPath'),
            slug: site.get('slug'),
            name: site.get('name')
          }
        }, promise;

      if (_.isFunction(model.render)) {
        promise = pt.timeout(Promise.resolve(model.render(uri, data, locals)), MODEL_TIMEOUT);
      } else {
        promise = Promise.resolve(cachedData);
      }

      return promise.then(function (preRenderedData) {
        preRenderedData.locals = locals;

        return dom.create(tpl(preRenderedData));
      });
    })
    .then(function (newEl) {
      window.kiln.trigger('save', data);
      return newEl;
    }).catch(progress.error('Error saving component'));
}

/**
 * Update data for a component. Returns the component's new rendered html
 *
 * Note: try to operate on full objects with schemas so we don't have to lookup the schema for validation.
 * Note: returns the re-rendered html string from the server
 *
 * @param {object} data  data that will be saved
 * @param {string} data._ref  uri to save
 * @param {object} [data._schema]  schema to validate against (optional; we can look this up)
 * @returns {Promise}
 */
function save(data) {
  var uri = data[refProp],
    schemaPromise = data._schema && Promise.resolve(data._schema) || cache.getSchema(uri);

  // get the schema and validate data
  return schemaPromise.then(function (schema) {
    var validationErrors = validate(data, schema),
      model = window.kiln.services.componentModels[_.camelCase(references.getComponentNameFromReference(uri))];

    if (validationErrors.length) {
      throw new Error(validationErrors);
    } else {
      let el = dom.find(`[data-uri="${uri}"]`);

      // todo: this is a short term fix for the "double-reloading" issue caused by
      // the fact that queued items may resolve more than once (which causes the components to be reloaded more than once)
      // a class is added to components when they're reloaded, which we explicitly REMOVE right before they get saved
      if (el) {
        el.classList.remove('kiln-handlers-added');
      }

      if (model && _.isFunction(model.save)) {
        // note: any component that re-renders client side MUST have a model.js w/ .save(), even if it's a simple passthrough
        return clientSave(uri, data);
      } else {
        return cache.saveForHTML(data)
          .then(function (savedData) {
            window.kiln.trigger('save', data);
            return savedData;
          }).catch(progress.error('Error saving component'));
      }
    }
  });
}

/**
 * Update data for a part of a component.
 * @param {object} data
 * @param {string} data._ref  uri to save
 * @returns {Promise}
 */
function savePartial(data) {
  var uri = data[refProp];

  // get the old version of the data, and fill in all the missing information
  return cache.getData(uri).then(function (oldData) {
    return save(_.defaults(data, oldData));
  });
}

/**
 * Remove a uri.
 *
 * @param {string} uri
 * @returns {Promise}
 * @example edit.removeUri('nymag.com/press')
 */
function removeUri(uri) {
  var prefix, base64Uri, targetUri;

  // assertion
  if (!_.isString(uri) || !db.isUri(uri)) {
    throw new TypeError('Expecting uri, not ' + uri);
  }

  prefix = site.get('prefix');
  base64Uri = btoa(uri);
  targetUri = prefix + urisRoute + base64Uri;

  return db.removeText(targetUri);
}

/**
 * Publish current page's saved data.
 *
 * Pages don't have schemas or validation (later?), so save directly to db.
 *
 * @returns {Promise.string}
 */
function publishPage() {
  var pageUri = dom.pageUri();

  return cache.getDataOnly(pageUri).then(function (pageData) {
    // pages don't have schemas or validation
    return queue.add(db.save, [pageUri + '@published', _.omit(pageData, '_ref')], 'publish');
  }).then(function (publishedPageData) {
    window.kiln.trigger('publish', publishedPageData);
    // note: when putting to page@published, amphora will add the uri to /uris/
    return publishedPageData.url;
  });
}

/**
 * get layout uri for current page
 * @returns {Promise}
 */
function getLayout() {
  return cache.getDataOnly(dom.pageUri()).then(data => data.layout);
}

/**
 * Publish current page's layout.
 *
 * @returns {Promise.string}
 */
function publishLayout() {
  return getLayout().then(function (layout) {
    return queue.add(db.save, [layout + '@published']); // PUT @published with empty data
  });
}

/**
 * unpublishes current page. returns the deleted uri
 * @returns {Promise}
 */
function unpublishPage() {
  var pageUri = dom.pageUri();

  return cache.getDataOnly(pageUri + '@published').then(function (pageData) {
    // change url into uri
    var uri = db.urlToUri(pageData.url);

    return removeUri(uri).then(function (res) {
      window.kiln.trigger('unpublish', res);
      return res;
    });;
  });
}

/**
 * Get a url for the page, including protocol and port
 * @returns {string}
 */
function getPageUrl() {
  return site.addProtocol(site.addPort(dom.pageUri())) + '.html';
}

/**
 * Get an edit mode url for the new page that was just created, including protocol, port and query string
 *
 * @param {string} uri
 * @returns {string}
 */
function getNewPageUrl(uri) {
  return site.addProtocol(site.addPort(uri + '.html?edit=true'));
}

/**
 * Get the default data for a component.
 *
 * @param  {string} name
 * @return {Promise}
 */
function getDefaultData(name) {
  var base = `${site.get('prefix')}/components/${name}`;

  return cache.getDataOnly(base);
}

/**
 * Create a new page, cloning the current page
 * @param {string} pageType to create ('new', 'new-sponsored', etc.)
 * @returns {Promise}
 */
function createPage(pageType) {
  var prefix = site.get('prefix'),
    newPageUri = prefix + pagesRoute + pageType;

  return cache.getDataOnly(newPageUri).then(function (data) {
    return db.create(prefix + pagesRoute, _.omit(data, '_ref')).then(function (res) {
      return getNewPageUrl(res[refProp]);
    }).catch(progress.error('Error creating page'));
  });
}

/**
 * synchronously determine if a component has references to default components
 * inside component lists. these child components will be cloned
 * when creating the parent component
 * @param {object} data
 * @returns {object}
 */
function getChildComponents(data) {
  let mapping = {};

  _.forOwn(data, function checkProperties(val, key) {
    // loop through the (base) data in the component
    if (_.isArray(val)) {
      // find arrays
      _.each(val, function checkArrays(item, index) {
        // see if these arrays contain components
        if (item._ref && item._ref.match(/\/components\/[A-Za-z0-9\-]+$/)) {
          // if they do, and if the component references are base (not instance) refs,
          // add them to the mapping object
          // note: we'll use the mapping object to update the parent component
          // after new instances are created
          mapping[`${key}[${index}]._ref`] = item._ref;
        }
      });
    }
  });

  return mapping;
}

/**
 * add child component refs into the current component's data
 * @param {object} data mapping of resolved child instance data (note: `self` is the current component)
 * @returns {object} the current component's data including proper child refs
 */
function addChildRefsToComponent(data) {
  let current = _.cloneDeep(data.self); // `data` is read-only, so clone it

  // go through the child components, deep setting their instances
  // in place of the base references
  _.forOwn(_.omit(data, 'self'), function (val, key) {
    _.set(current, key, val._ref);
  });

  // return the current component's data
  return current;
}

/**
 * create a component AND its children, then add the new child instances
 * to the component we've created
 * @param {string} instance
 * @param {object} defaultData
 * @param {object} children
 * @returns {Promise} with final component data (NOT html, since it needs to add itself to its parent)
 */
function createComponentAndChildren(instance, defaultData, children) {
  let promises = {
    self: cache.createThrough(instance, defaultData)
    // POST /components/<current component>/instances
  };

  // go through the children, get their default data, and create new instances
  _.forOwn(children, function (val, key) {
    let name = references.getComponentNameFromReference(val),
      childBase = site.get('prefix') + '/components/' + name,
      childInstance = childBase + '/instances';

    promises[key] = cache.getDataOnly(childBase)
      .then(function (childDefaultData) {
        return cache.createThrough(childInstance, childDefaultData);
        // POST /components/<child component>/instances
        // note: we're creating the current component AND its children in parallel
        // so this is relatively fast
      });
  });

  // once we have the created component refs, we can add them to the current component
  // and save the final component data (including proper child refs)
  return promise.props(promises).then(addChildRefsToComponent).then(function (newData) {
    return cache.saveThrough(newData);
  });
}

/**
 * Create a new component.
 *
 * Assumes creation is happening at current site prefix.
 *
 * @param {string} name     The name of the component.
 * @param {object} [data]   Data to save.
 * @returns {Promise}
 */
function createComponent(name, data) {
  var base = site.get('prefix') + '/components/' + name,
    instance = base + '/instances',
    getDefaultData;

  if (data) {
    // if we passed through data, use it
    getDefaultData = Promise.resolve(data);
  } else {
    // otherwise get the component's default data
    getDefaultData = cache.getDataOnly(base);
  }

  return getDefaultData.then(function (defaultData) {
    let children = getChildComponents(defaultData);

    if (_.size(children)) {
      return createComponentAndChildren(instance, defaultData, children);
    } else {
      return cache.createThrough(instance, defaultData);
    }
  }).catch(progress.error(`Error creating component (${label(name)})`));
}

/**
 * Remove a component from a list.
 * @param {object} parentData
 * @param {object}  options
 * @param {Element} options.el          The component to be removed.
 * @param {string}  options.ref         The ref of the component to be removed.
 * @param {string}  options.parentField
 * @param {string}  options.parentRef
 * @returns {Promise}
 */
function removeFromComponentList(parentData, options) {
  var el = options.el,
    ref = options.ref,
    parentField = options.parentField,
    item = {},
    index;

  parentData = _.cloneDeep(parentData);
  item[refProp] = ref;
  index = _.findIndex(parentData[parentField], item);
  parentData[parentField].splice(index, 1); // remove component from parent data
  if (el && el.nodeType === el.ELEMENT_NODE) {
    dom.removeElement(el); // remove component from DOM (note: head components are removed manually)
  }
  return save(parentData);
}

/**
 * Remove a component from a list.
 * @param {object}  options
 * @param {Element} options.el          The component to be removed.
 * @param {string}  options.ref         The ref of the component to be removed.
 * @param {string}  options.parentField
 * @returns {Promise}
 */
function removeFromPageList(options) {
  var el = options.el,
    ref = options.ref,
    parentField = options.parentField,
    pageUri = dom.pageUri(),
    index;

  return db.get(pageUri).then(function (pageData) {
    pageData = _.cloneDeep(pageData);
    index = pageData[parentField].indexOf(ref);
    pageData[parentField].splice(index, 1); // remove component from parent data
    if (el && el.nodeType === el.ELEMENT_NODE) {
      dom.removeElement(el); // remove component from DOM (note: head components are removed manually)
    }
    return queue.add(db.save, [pageUri, _.omit(pageData, '_ref')]);
  });
}

/**
 * Remove a component from a list.
 * @param {object}  opts
 * @param {Element} opts.el          The component to be removed.
 * @param {string}  opts.ref         The ref of the component to be removed.
 * @param {string}  opts.parentField
 * @param {string}  opts.parentRef
 * @returns {Promise}
 */
function removeFromParentList(opts) {
  var parentRef = opts.parentRef,
    parentField = opts.parentField;

  return cache.getData(parentRef).then(function (parentData) {
    if (_.isArray(parentData[parentField])) {
      // regular ol' component list
      return removeFromComponentList(parentData, opts);
    } else {
      // the parent is actually a page!
      return removeFromPageList(opts);
    }
  });
}

/**
 * add a component to a component list
 * @param {object} parentData
 * @param {object} options
 * @param {string} options.ref new component ref
 * @param {string} [options.prevRef] (optionally) insert the new component after this ref
 * @param {string} [options.above] (optionally) insert the new component above the element specified in the prevRef
 * @param {string} options.parentField
 * @param {string} options.parentRef
 * @returns {Promise} Promise resolves to new component Element.
 */
function addToComponentList(parentData, options) {
  var ref = options.ref,
    prevRef = options.prevRef,
    above = options.above,
    parentField = options.parentField,
    prevIndex,
    prevItem = {},
    item = {};

  parentData = _.cloneDeep(parentData);
  item[refProp] = ref;
  if (prevRef && !above) {
    // Add to specific position in the list.
    prevItem[refProp] = prevRef;
    prevIndex = _.findIndex(parentData[parentField], prevItem);
    parentData[parentField].splice(prevIndex + 1, 0, item);
  } else if (prevRef && above) {
    // Add above a specific position in the list
    prevItem[refProp] = prevRef;
    prevIndex = _.findIndex(parentData[parentField], prevItem);
    parentData[parentField].splice(prevIndex, 0, item);
  } else {
    // Add to end of list.
    parentData[parentField].push(item);
  }

  return Promise.all([
    // save the parent and get the child's html in parallel
    // note: this assumes the child already exists
    // todo: when we can POST and get html back, just handle the parent here
    save(parentData),
    db.getHTML(ref)
  ]).then(results => results[1]); // return the child component's html
}

/**
 * add a component to a page area
 * @param {object} options
 * @param {string} options.ref new component ref
 * @param {string} [options.prevRef] (optionally) insert the new component after this ref
 * @param {string} options.parentField
 * @returns {Promise} Promise resolves to new component Element.
 */
function addToPageList(options) {
  var ref = options.ref,
    prevRef = options.prevRef,
    parentField = options.parentField,
    pageUri = dom.pageUri(),
    prevIndex;

  return db.get(pageUri).then(function (pageData) {
    pageData = _.cloneDeep(pageData);
    if (prevRef) {
      // add to specific position in the page area
      prevIndex = pageData[parentField].indexOf(prevRef);
      pageData[parentField].splice(prevIndex + 1, 0, ref);
    } else {
      // add to end of page area
      pageData[parentField].push(ref);
    }

    return Promise.all([
      // save the parent and get the child's html in parallel
      // note: this assumes the child already exists
      queue.add(db.save, [pageUri, _.omit(pageData, '_ref')]), // call db.save directly, not edit.save
      // edit.save is only for saving components
      db.getHTML(ref)
    ]).then(results => results[1]); // return the child component's html
  });
}

/**
 * Add a component to the parent list data. If prevRef is not provided, adds to the end of the list.
 * @param {object} opts
 * @param {string} opts.ref
 * @param {string} [opts.prevRef]     The ref of the item to insert after.
 * * @param {string} [options.above] (optionally) insert the new component above the element specified in the prevRef
 * @param {string} opts.parentField
 * @param {string} opts.parentRef
 * @returns {Promise} Promise resolves to new component Element.
 */
function addToParentList(opts) {
  var parentField = opts.parentField,
    parentRef = opts.parentRef;

  return cache.getData(parentRef).then(function (parentData) {
    if (_.isArray(parentData[parentField])) {
      // regular ol' component list
      return addToComponentList(parentData, opts);
    } else {
      // the parent is actually a page!
      return addToPageList(opts);
    }
  });
}

/**
 * Add multiple components to the parent list data. If prevRef is not provided, adds to the end of the list.
 * @param {object} opts
 * @param {array} opts.refs
 * @param {string} [opts.prevRef]     The ref of the item to insert after.
 * @param {number} [opts.insertIndex] actual index to insert first item into (allows adding multiple components above existing components)
 * @param {string} opts.parentField
 * @param {string} opts.parentRef
 * @returns {Promise} Promise resolves to new parent Element.
 */
function addMultipleToParentList(opts) {
  var refs = opts.refs,
    prevRef = opts.prevRef,
    insertIndex = opts.insertIndex,
    parentField = opts.parentField,
    parentRef = opts.parentRef;

  return cache.getData(parentRef).then(function (parentData) {
    var prevIndex,
      prevItem = {},
      items = _.map(refs, function (ref) {
        return {
          _ref: ref
        };
      });

    parentData = _.cloneDeep(parentData);
    if (_.isNumber(insertIndex)) { // insertIndex might be 0, hence no truthy checking
      // add to specific starting position in list
      parentData[parentField].splice(insertIndex, 0, items); // note: this creates a deep array
      parentData[parentField] = _.flatten(parentData[parentField]); // so flatten it afterwards
    } else if (prevRef) {
      // start adding after specified component ref
      prevItem[refProp] = prevRef;
      prevIndex = _.findIndex(parentData[parentField], prevItem);
      parentData[parentField].splice(prevIndex + 1, 0, items); // note: this creates a deep array
      parentData[parentField] = _.flatten(parentData[parentField]); // so flatten it afterwards
    } else {
      // Add to end of list.
      parentData[parentField] = parentData[parentField].concat(items);
    }

    return save(parentData) // returns parent html
      .catch(progress.error('Error adding components'));
  });
}

/**
 * schedule publish
 * @param {object} data
 * @param {number} data.at unix timestamp to be published at
 * @param {string} data.publish url to be published
 * @returns {Promise}
 */
function schedulePublish(data) {
  var prefix = site.get('prefix');

  return db.create(prefix + scheduleRoute, data)
    .then(function (res) {
      window.kiln.trigger('schedule', res);
      return res;
    });
}

/**
 * unschedule publish
 * @param {string} uri
 * @returns {Promise}
 */
function unschedulePublish(uri) {
  var scheduled = uri + '@scheduled';

  // see if it's currently scheduled, and if it is remove it
  return db.get(scheduled).then(function (res) {
    return db.remove(res._ref) // _ref points to the /schedule entry
      .then(function (removed) {
        window.kiln.trigger('unschedule', removed);
        return removed;
      });
  }).catch(_.noop);
}

/**
 * The sad state is that people think they can write to anything in JavaScript without consequence.  For those people,
 * these functions exist.
 *
 * No caching in the world will save them.
 *
 * @param {string} uri
 * @returns {object}
 */
function getData(uri) {
  return cache.getData(uri).then(_.cloneDeep).then(addDeviantArraySchemas);
}

/**
 * The sad state is that people think they can write to anything in JavaScript without consequence.  For those people,
 * these functions exist.
 *
 * No caching in the world will save them.
 *
 * @param {string} uri
 * @returns {object}
 */
function getDataOnly(uri) {
  return cache.getDataOnly(uri).then(_.cloneDeep).then(addDeviantArraySchemas);
}

/**
 * get the component ref, properly handling layouts
 * note: layouts get passed the page uri, so we'll need to get the layout from the page data
 * @param {string} uri
 * @returns {Promise}
 */
function getComponentRef(uri) {
  if (uri === dom.pageUri()) {
    return cache.getDataOnly(uri).then(pageData => pageData.layout);
  } else {
    return Promise.resolve(uri);
  }
}

/**
 * get the component's HTML and pass along any query parameters
 * that may need to be exposed to the component in its server.js
 * file. This is handy for passing the current page URL to the
 * component for re-rendering when in edit mode.
 *
 * TODO: Currently this is ONLY used for the Space component because
 * querying for article tags is limited. There is a pending update
 * to our elastic indices that should make this unecessary. At that
 * point this should be removed.
 *
 * @param  {string} uri
 * @param  {object} query
 * @return {Promise}
 */
function getHTMLWithQuery(uri, query) {
  var queryString = queryObjectToString(query);

  if (!queryString) {
    throw new Error('A query param is required to use getHTMLWithQuery');
  }

  return db.getHTMLWithQuery(uri, encodeURIComponent(queryString));
}

/**
 * get a component's HTML
 * @param  {string} uri
 * @return {Promise}
 */
function getHTML(uri) {
  if (!uri) {
    throw new Error('A component uri is required for getHTML');
  }

  return db.getHTML(uri);
}

/**
 * turn an object into query string for getHTMLWithQuery.
 * Key-value pairs will be separated with `&` but no question
 * mark is added to the beginning.
 *
 * @param  {object} queryObj
 * @return {string}
 */
function queryObjectToString(queryObj) {
  var string = '';

  _.forIn(queryObj, function (val, key) {
    string = string + '&' + key + '=' + val;
  });

  return string;
}

// Expose main actions (alphabetical!)
module.exports = {
  // Please use these.  They should be discrete actions that should be well tested.
  addToParentList: addToParentList,
  addMultipleToParentList: addMultipleToParentList,
  createComponent: createComponent,
  createPage: createPage,
  publishPage: publishPage,
  getLayout: getLayout,
  getPageUrl: getPageUrl,
  publishLayout: publishLayout,
  unpublishPage: unpublishPage,
  removeFromParentList: removeFromParentList,
  removeUri: removeUri,
  savePartial: savePartial,
  save: save,
  schedulePublish: schedulePublish,
  unschedulePublish: unschedulePublish,
  getComponentRef: getComponentRef,
  getHTMLWithQuery: getHTMLWithQuery,
  getHTML: getHTML,
  getDefaultData: getDefaultData,

  // Please stop using these.  If you use these, we don't trust you.  Do you trust yourself?
  getData: getData,
  getDataOnly: getDataOnly,
  getSchema: cache.getSchema // No one should _ever_ be editing this, so pass them the read-only.  Kill them dead.
};

_.set(window, 'kiln.services.edit', module.exports); // export for plugins
