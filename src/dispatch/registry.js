'use strict';

/**
 * dispatch/registry.js — provider + action registry.
 *
 * Providers register themselves here. The dispatcher resolves which provider
 * handles a given URL, then invokes the requested action.
 *
 * Actions supported:
 *   scrape   — full sequential lesson acquisition (main flow)
 *   patch    — re-process already-captured lessons (post-scrape fixes)
 *
 * The registry is a lightweight map; no heavy DI container needed.
 */

const providers = new Map();

/**
 * Register a provider instance.
 * @param {BaseProvider} provider
 */
function registerProvider(provider) {
  if (!provider || !provider.name) {
    throw new Error('registerProvider: provider must have a .name property');
  }
  providers.set(provider.name, provider);
}

/**
 * Look up a provider by name.
 * @param {string} name
 * @returns {BaseProvider}
 */
function getProvider(name) {
  const p = providers.get(name);
  if (!p) {
    const available = [...providers.keys()].join(', ') || '(none registered)';
    throw new Error(`No provider registered for "${name}". Available: ${available}`);
  }
  return p;
}

/**
 * List all registered provider names.
 * @returns {string[]}
 */
function listProviders() {
  return [...providers.keys()];
}

module.exports = { registerProvider, getProvider, listProviders };
