/**
 * @file packages/runtime-config/index.js
 * @description cs-runtime.json 轻量校验与规范化（无额外依赖）
 */

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], value?: object }}
 */
function validateRuntimeConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ["root must be object"] };

  const value = JSON.parse(JSON.stringify(raw));

  if (value.autoSend !== undefined && typeof value.autoSend !== "boolean") {
    errors.push("autoSend must be boolean");
  }
  if (value.whitelistOnly !== undefined && typeof value.whitelistOnly !== "boolean") {
    errors.push("whitelistOnly must be boolean");
  }
  if (value.onlyActionable !== undefined && typeof value.onlyActionable !== "boolean") {
    errors.push("onlyActionable must be boolean");
  }

  if (value.platforms) {
    if (!isObj(value.platforms)) errors.push("platforms must be object");
    else {
      for (const name of ["meituan", "douyin"]) {
        const p = value.platforms[name];
        if (p == null) continue;
        if (!isObj(p)) errors.push(`platforms.${name} must be object`);
        else {
          if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
            errors.push(`platforms.${name}.enabled must be boolean`);
          }
          if (p.autoSend !== undefined && typeof p.autoSend !== "boolean") {
            errors.push(`platforms.${name}.autoSend must be boolean`);
          }
        }
      }
    }
  }

  if (value.whitelist) {
    if (!isObj(value.whitelist)) errors.push("whitelist must be object");
    else {
      for (const name of ["meituan", "douyin"]) {
        const list = value.whitelist[name];
        if (list == null) continue;
        if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
          errors.push(`whitelist.${name} must be string[]`);
        }
      }
    }
  }

  if (value.knowledge) {
    if (!isObj(value.knowledge)) errors.push("knowledge must be object");
    else if (value.knowledge.mode && !["remote", "local"].includes(String(value.knowledge.mode))) {
      errors.push("knowledge.mode must be remote|local");
    }
  }

  if (value.systems?.order) {
    const o = value.systems.order;
    if (!isObj(o)) errors.push("systems.order must be object");
    else {
      if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
        errors.push("systems.order.enabled must be boolean");
      }
      if (o.intentMode && !["ai", "rules", "ai+rules"].includes(String(o.intentMode))) {
        errors.push("systems.order.intentMode must be ai|rules|ai+rules");
      }
      if (o.maxResults !== undefined) {
        const n = Number(o.maxResults);
        if (!Number.isFinite(n) || n < 1 || n > 20) errors.push("systems.order.maxResults must be 1..20");
      }
      if (o.baseUrl !== undefined && typeof o.baseUrl !== "string") {
        errors.push("systems.order.baseUrl must be string");
      }
    }
  }

  return { ok: errors.length === 0, errors, value: errors.length ? undefined : value };
}

module.exports = {
  validateRuntimeConfig,
};
