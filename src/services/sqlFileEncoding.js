"use strict";

const fs = require("fs");

const UTF8_BOM = "\uFEFF";

function withUtf8Bom(text) {
  return `${UTF8_BOM}${String(text || "").replace(/^\uFEFF/, "")}`;
}

function writeSqlFileSync(filePath, sqlText) {
  fs.writeFileSync(filePath, withUtf8Bom(sqlText), "utf8");
}

module.exports = {
  UTF8_BOM,
  withUtf8Bom,
  writeSqlFileSync,
};