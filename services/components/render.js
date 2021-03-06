import _ from 'lodash';

var componentEdit = require('../../controllers/component-edit'),
  componentEditName = 'component-edit',
  db = require('../edit/db'),
  dom = require('@nymag/dom'),
  ds = require('dollar-slice'),
  edit = require('../edit'),
  references = require('../references'),
  select = require('./select');

/**
 * Test if element is a component and not the toolbar.
 * @param {Element} el
 * @returns {boolean}
 */
function isComponent(el) {
  var ref = el instanceof Element && el.getAttribute(references.referenceAttribute),
    name = ref && references.getComponentNameFromReference(ref);

  if (ref && ref === dom.pageUri()) {
    // this component is the layout
    return true;
  }

  return !!(name && name !== 'clay-kiln');
}

/**
 * Returns an array of elements that are components from an el and its children.
 * @param {Element} el  Note: element must exist in the DOM so that querySelectorAll works.
 * @returns {array}
 */
function findComponents(el) {
  var children = [].slice.call(dom.findAll(el, '[' + references.referenceAttribute + ']')),
    selfAndChildren = [el].concat(children),
    components = selfAndChildren.filter(isComponent);

  return components;
}

/**
 * Adds selector to a component element. Is async because needs to get data.
 * @param {Element} el    The component element.
 * @returns {Promise|undefined}
 */
function addComponentSelector(el) {
  var ref = el.getAttribute(references.referenceAttribute);

  return edit.getComponentRef(ref).then(function (componentRef) {
    return edit.getData(componentRef)
      .catch(function (e) {
        // e.g. tried to get the schema of a component, and it 404'd
        if (e.message === '404') {
          return null; // data is empty
        } else {
          return e; // something weird happened. don't eat the error
        }
      })
      .then(function (data) {
        var options = {
          ref: componentRef,
          path: el.getAttribute(references.editableAttribute),
          data: data || {}
        };

        select.handler(el, options);
        return el;
      });
  });
}

/**
 * Add handlers to all of the element and all of its children that are components.
 * @param {Element} el
 * @returns {Promise}
 */
function addComponentsHandlers(el) {
  ds.controller(componentEditName, componentEdit);
  // First, add the selectors.
  return Promise.all(findComponents(el).map(addComponentSelector))
    .then(function (els) {
      // Then, add controllers/decorators after all selectors have be added.
      return Promise.all(els.map(function (componentEl) {
        return ds.get(componentEditName, componentEl); // async because gets data for editable fields.
      }));
    });
}

/**
 * determine if a component needs to be re-rendered
 * note: we need to check it because otherwise queued PUTs might run this twice
 * @param  {Element} currentEl
 * @param  {Element} el
 * @return {Promise}
 */
function replaceAndAddHandlers(currentEl, el) {
  // todo: this is a short term fix for the "double-reloading" issue caused by
  // the fact that queued items may resolve more than once (which causes the components to be reloaded more than once)
  // a class is added to components when they're reloaded, which we explicitly REMOVE right before they get saved
  if (currentEl.classList.contains('kiln-handlers-added')) {
    // this component was just reloaded (i.e. not saved any time since the last reload),
    // so resolve immediately with the current element
    return Promise.resolve(currentEl);
  } else {
    // this component was NOT reloaded (i.e. it was either saved, or this was the first time reloading since a page load),
    // so replace the current element (with the new one) and add the component handlers
    dom.replaceElement(currentEl, el);
    el.classList.add('kiln-handlers-added');
    return addComponentsHandlers(el);
  }
}
/**
 * Reload component with latest HTML from the server.
 * @param {string} ref
 * @param {string} [html]
 * @returns {Promise}
 */
function reloadComponent(ref, html) {
  var serverHtml = html ? Promise.resolve(html) : db.getHTML(ref);

  return serverHtml
    .then(function (el) {
      var currentEls = dom.findAll('[' + references.referenceAttribute + '="' + ref + '"]');

      switch (currentEls.length) {
        case 0: // Element was already removed from the DOM.
          break;
        case 1: // Normal case.
          return replaceAndAddHandlers(currentEls[0], el);
        default: // Edge case (ref used multiple times on one page).
          window.location.reload();
      }
    });
}

exports.addComponentsHandlers = addComponentsHandlers;
exports.reloadComponent = reloadComponent;
_.set(window, 'kiln.services.render', exports); // export for plugins
