"use strict";
// Shared source/candidate validation; historical comparisons keep their original identity.
(function(root,factory){
  const api=factory();
  if(typeof module === "object" && module.exports) module.exports=api;
  else root.reviewValidation=api;
})(typeof window === "object" ? window : globalThis, function(){
 function createValidator(){
  let knownSources = null;
  const hashPattern = /^[0-9a-f]{64}$/i;
  function reject(code, message){
    const error = new Error(message);
    error.code = "review-validation:" + code;
    throw error;
  }
  function ready(){
    if(knownSources === null) reject("not-ready", "图片清单尚未完成加载，原记录已保留；请稍后重试或导出诊断");
  }
  function configureSources(items){
    if(!Array.isArray(items)) reject("sources", "来源清单必须是数组");
    const next = new Map();
    for(const item of items){
      if(!item || typeof item.source_uid !== "string" || !hashPattern.test(item.source_sha256 || ""))
        reject("sources", "来源清单缺少有效身份");
      if(next.has(item.source_uid) && next.get(item.source_uid) !== item.source_sha256)
        reject("sources", "同一来源编号存在不同来源哈希");
      next.set(item.source_uid, item.source_sha256);
    }
    knownSources = next;
  }
  function validateHistoryEntry(entry){
    ready();
    if(entry === null || typeof entry !== "object" || Array.isArray(entry))
      reject("entry", "标注条目必须是对象");
    if(typeof entry.source_uid !== "string" || !knownSources.has(entry.source_uid)
        || entry.source_sha256 !== knownSources.get(entry.source_uid))
      reject("source", "标注来源编号或来源哈希与已知来源不符");
    if(!["old", "new", "redo"].includes(entry.choice)) reject("choice", "选择值无效");
    if(!Array.isArray(entry.versions) || entry.versions.length === 0)
      reject("versions", "比较候选必须是非空数组");
    const slots = new Set();
    const versions = entry.versions.map(version=>{
      if(version === null || typeof version !== "object" || Array.isArray(version)
          || !["old", "new"].includes(version.key) || slots.has(version.key)
          || typeof version.native_sha256 !== "string" || !hashPattern.test(version.native_sha256))
        reject("versions", "候选槽位必须唯一，并包含格式有效的 native 哈希");
      slots.add(version.key);
      return {...version, key:version.key, native_sha256:version.native_sha256};
    });
    const selected = entry.choice === "redo" ? null : versions.find(v=>v.key === entry.choice);
    if(entry.choice !== "redo" && !selected) reject("selected-version", "被选版本不在这次比较候选中");
    const native = selected?.native_sha256 || null;
    if(Object.prototype.hasOwnProperty.call(entry, "selected_native_sha256")
        && entry.selected_native_sha256 !== native)
      reject("selected-native", "已保存的选中哈希与选择槽位不一致");
    // Historical native hashes need not equal the current manifest's candidates.
    // Keep timestamp, generation and other provenance fields as supplied.
    return {...entry, versions, selected_native_sha256:native};
  }
  const snapshot = value=>value === undefined ? null : JSON.parse(JSON.stringify(value));
  return Object.freeze({configureSources, validateHistoryEntry,
    ready, isReady:()=>knownSources !== null, snapshot});
 }
 return Object.freeze({...createValidator(),createValidator});
});
