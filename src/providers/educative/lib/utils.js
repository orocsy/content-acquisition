'use strict';

/**
 * providers/educative/lib/utils.js
 *
 * Educative-specific URL helpers (thin wrappers used by curriculum/navigation
 * modules that were written before the shared core/utils existed).
 *
 * Re-exports generic helpers from core/utils and adds the educative-specific
 * normalizeLessonUrl that forces the hostname to www.educative.io.
 */

const coreUtils = require('../../../core/utils');

function normalizeLessonUrl(input) {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  url.hostname = 'www.educative.io';
  return url.toString();
}

module.exports = {
  ...coreUtils,
  normalizeLessonUrl,
};
