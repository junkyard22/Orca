/* provider-options.js — role → provider <select> options for Settings.
 *
 * Roles reference providers by stable id (`providerId`), and the main process
 * resolves them the same way (`providers.find(p => p.id === providerId)`).
 * The <select> must therefore reflect exactly that lookup: when a role points
 * at an id that no longer exists (e.g. the provider was removed or recreated),
 * render an explicit "missing provider" placeholder as the selected option
 * instead of letting the browser fall back to showing the first provider —
 * which displayed a provider the role was not actually assigned to.
 *
 * Pure function, no DOM access. Loaded as a classic <script> in the renderer
 * (exposes window.ProviderOptions) and via require() in tests.
 */
(function (root) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildProviderOptions(providers, currentProviderId) {
    if (!Array.isArray(providers) || providers.length === 0) {
      return '<option value="">— add a provider first —</option>';
    }
    const known = providers.some((p) => p.id === currentProviderId);
    let lead = "";
    if (!currentProviderId) {
      lead = '<option value="">— select —</option>';
    } else if (!known) {
      lead = '<option value="" selected>⚠ provider missing — select one</option>';
    }
    return lead + providers
      .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === currentProviderId ? " selected" : ""}>${escapeHtml(p.name)}</option>`)
      .join("");
  }

  const api = { buildProviderOptions: buildProviderOptions };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) root.ProviderOptions = api;
})(typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : null));
