# CAN RAT FIELD / NESTWORKS 3D

商业化网页游戏方向的前后端分离原型。

## 技术栈

- Frontend：Vite + TypeScript + Babylon.js
- Rendering：WebGPU 优先，WebGL 2 fallback
- Backend：Fastify + TypeScript
- Shared contracts：workspace 共享类型
- Persistence：JSON repository（原型）；接口已隔离，可替换 PostgreSQL/Redis

## 本地运行

要求 Node.js 22+。

```bash
npm install
npm run dev
```

前端默认：

```text
http://localhost:5173
```

后端默认：

```text
http://localhost:8787
```

生产构建：

```bash
npm run build
npm run start
```

生产环境应由 CDN/Nginx 托管 `apps/client/dist`，并将 `/api` 反向代理到 Fastify。

## 已实现

- 真正 3D 正交等距视角
- WebGPU / WebGL 自动回退
- 上层回收场与下层创业公司
- 滚轮平滑切换楼层
- 易拉罐落地、弹跳、旋转与局部冲击反馈
- 点击位置决定踩压垂直度
- `Quality = Brand Base × Stomp Modifier`
- 品牌只通过罐身色彩与图形带表达
- 老鼠从巢穴出发、取货、返巢后结算
- 服务端权威计算售价、加工队列和招聘成本
- 直售与加工两种经营模式
- Runner / Hauler / Broker / Engineer 招募
- 服务端存档与离线加工结算
- 画质档位与移动端降级

## 生产化下一步

1. 将 JSON repository 替换为 PostgreSQL，并引入账号、事务和幂等键。
2. 将 `/api/deliver` 加入签名、重放防护、速率限制和行为校验。
3. 使用 glTF 制作商业角色与场景资产，接入 Draco/KTX2 压缩。
4. 引入对象池、thin instances、LOD、GPU particles 与纹理图集。
5. 建立遥测事件、崩溃上报、A/B 配置和远程数值表。
6. 将服务端分为 API、simulation worker、persistence 和 analytics。
