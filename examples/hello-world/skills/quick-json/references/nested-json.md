# 嵌套 JSON 处理要点

处理形如 `{ "data": { "items": [...] } }` 的嵌套结构时：

## 安全取值

```js
const items = data?.data?.items ?? []
// 等价手写防御链，避免 null 崩溃
```

## 嵌套展开（flatten）

```js
function flatten(arr, parentKey = '') {
  const out = []
  for (const item of arr) {
    const entry = { ...item }
    if (Array.isArray(item.children)) {
      out.push(...flatten(item.children, item.key))
    }
    delete entry.children
    out.push(entry)
  }
  return out
}
```

## 深层查找

```js
function findDeep(obj, key) {
  if (obj == null) return undefined
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  for (const v of Object.values(obj)) {
    const hit = findDeep(v, key)
    if (hit !== undefined) return hit
  }
  return undefined
}
```

> 嵌套深度不可控时优先用 `JSON.stringify(obj, null, 2)` 先目测结构，再决定遍历策略。