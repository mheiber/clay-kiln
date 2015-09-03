var striptags = require('striptags'),
  dom = require('../services/dom'),
  getInput = require('../services/get-input');

/**
 * toggle classes on elements
 * @param {boolean} isTooLong
 * @param {Element} span
 * @param {Element} input
 */
function toggleClass(isTooLong, span, input) {
  if (isTooLong) {
    span.classList.add('too-long');
    input.classList.add('input-too-long');
  } else {
    span.classList.remove('too-long');
    input.classList.remove('input-too-long');
  }
}

/**
 * set text in a span
 * @param {string} text
 * @param {Element} span
 */
function setText(text, span) {
  span.innerHTML = text;
}

/**
 * set styles depending on the remaining length
 * @param {number} remaining
 * @param {Element} el
 */
function setStyles(remaining, el) {
  var input = getInput(el.parentNode),
    span = el;

  if (remaining > 0) {
    toggleClass(false, span, input);
    setText('Remaining: ' + remaining, span);
  } else if (remaining === 0) {
    toggleClass(false, span, input);
    setText('At the character limit', span);
  } else if (remaining === -1) {
    toggleClass(true, span, input);
    setText(-remaining + ' character over the limit', span);
  } else {
    toggleClass(true, span, input);
    setText(-remaining + ' characters over the limit', span);
  }
}

/**
 * Remove tags and white spaces.
 * @param {string} value
 * @returns {string}
 */
function cleanValue(value) {
  var clean = striptags(value);

  clean = clean.replace(/(\u00a0|&nbsp;|&#160;)/ig, ' '); // remove &nbsp;
  return clean;
}

/**
 * Add soft max length: appends el and adds formatter.
 * @param {{name: string, el: Element, bindings: {}, formatters: {}}} result
 * @param {{value: string}} args
 * @returns {{}}
 */
module.exports = function (result, args) {
  var el = result.el,
    bindings = result.bindings,
    name = result.name,
    tpl = `
      <span class="soft-maxlength" rv-remaining="${name}.data.value"></span>
    `,
    span = dom.create(tpl);

  bindings.max = args.value;

  result.binders.remaining = function (el, value) {
    var length = cleanValue(value).length,
      remaining = bindings.max - length;

    setStyles(remaining, el);
  };

  el.appendChild(span);
  return result;
};
