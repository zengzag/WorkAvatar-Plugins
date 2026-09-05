---
name: quick-json
description: 使用宿主内置 javascript_exec 沙箱（内置 xlsx/docx/adm-zip 等）快速处理 JSON 数据：校验、格式化、字段提取、批量转换。文件类处理优于手写 shell。
license: MIT
allowed-tools: javascript_exec, file_read, file_write
---

# Quick JSON

针对 JSON 数据的快速处理指南，全程使用宿主内置的 `javascript_exec` 工具（Node.js vm 沙箱），**无需 npm install**。

## 基本原则

- 短逻辑（<800 字符）直接写 `code` 参数；长逻辑写 `.js` 文件用 `code_file` 执行。
- 输入输出均为 UTF-8；处理文件时先 `file_read` 读取，结果用 `file_write` 落盘。
- 大文件（>5MB）建议按行流式处理，避免一次性载入内存。

## 常规操作

1. **校验并格式化**：`JSON.parse` 失败时定位错误行/列，用 `JSON.stringify(value, null, 2)` 输出。
2. **提取字段**：对数组批量 `map` 出目标字段并去重（`[...new Set(arr.map(x => x.key))]`）。
3. **批量转换**：多表联查/字段重命名用对象映射表，一次遍历完成。

## 输出规范

- 返回给用户的汇总：只输出关键统计（条数、匹配数、异常数），不要粘贴整个 JSON。
- 数据量小（<50 行）时可直接贴出处理结果表格。

## 参考资料

处理复杂嵌套结构（如 `{ data: { items: [...] } }`）时，用 `file_read` 按需读取 `references/nested-json.md`。