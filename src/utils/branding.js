"use strict";

// Preserve custom configured names and never rewrite the user's configuration.
function botName(name) {
  return !name || String(name).trim().toLowerCase() === "jarfis" ? "Michael" : name;
}
module.exports = { botName };
