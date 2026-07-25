/**
 * @file apps/edge-worker/paths.js
 * @description 仓库根路径（apps/edge-worker → 上两级）
 */
const path = require("path");

const EDGE_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, "../..");

module.exports = { EDGE_ROOT, PROJECT_ROOT };
