# 验证记录 · 2026-09-18

## 实际执行

| 检查 | 结果 |
|---|---|
| `node --check sunset-street/scene.js` | 通过 |
| `node --test sunset-street/calibration.test.js` | 2/2 通过 |
| `npm run build` | 通过；存在项目已有的大体积 bundle 提示 |
| `npm test` | 835 通过、1 失败；不能记为全绿 |
| 失败用例定向重跑 | 通过，115 个无关用例被测试名过滤 |
| `node sunset-street/build.mjs` | 独立页面构建通过；Three.js bundle 约 527 KB，gzip 约 140 KB |
| 开发页面实际 WebGL 渲染 | 已查看并迭代 |
| 空间总览 | 已查看，确认实体建筑、地面坡度与街道纵深 |
| 结构模式 | 已查看，确认背景隐藏、几何保留 |

全量失败项：`tests/mapCodePlanner.test.ts` 中 `keeps the original usable scene when optional visual correction returns invalid code`，预期 fetch 调用 2 次而实际 1 次。定向重跑通过；原因未在本任务中确定。此任务未更改或引入对该规划模块的调用。

开发期间曾出现一处负号与指数运算的语法错误，已修复并通过语法检查；浏览器历史日志可能仍保留其旧记录。

## 证据

`evidence/` 保存浏览器实际截图。截图用于证明当前运行结果，不能代替原图艺术质量验收。

没有计算像素误差或图像相似度分数，没有获得用户视觉验收。精确回投影测试只验证相机锚点，不验证整幅图像的材质、遮挡、轮廓与云层。

## 未完成的视觉目标

- 未达到逐像素一致，尤其云形、画风、路面湿润质感与建筑细部差异明显。
- 建筑背面为人工补全；远景天空为有限平面，不是 360° 实景。
- 未测量交互帧率，不能宣称稳定达到某个 FPS。
- 独立预览未集成到 WorldForge 的地图存储和编辑流程。

本次新增内容全部位于 `sunset-street/`；编译输出位于被忽略的 `dist/sunset-street/`。未提交、推送或发布。
