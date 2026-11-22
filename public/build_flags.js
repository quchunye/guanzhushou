/* 构建级常量（不是 URL 开关）：仓库里默认研发态 false。
   出商店包时执行 `node tools/build_store.js`，产物 dist/store 会把这里改成 true：
   商店包里「真实回放 f=real」与「自带数据导入 kimport」恒关，URL 参数和本地 flags 都打不开。 */
window.PANJI_STORE_BUILD = false;
