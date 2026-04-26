const { stripTypeScriptTypes } = require("node:module");

module.exports = function temporalTypeScriptLoader(source) {
  this.cacheable?.();

  return stripTypeScriptTypes(String(source), {
    mode: "transform",
    sourceUrl: this.resourcePath,
  });
};