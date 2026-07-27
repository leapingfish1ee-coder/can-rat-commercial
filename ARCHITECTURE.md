# Architecture / 技术架构

## Runtime boundaries

### Client

客户端负责：

- Babylon.js rendering
- Input and local animation
- Can fall/stomp visual simulation
- Rat navigation and presentation
- Floor camera transition
- UI composition
- Temporary network-loss tolerance

客户端不应直接决定最终货币收入。

### Server

服务端负责：

- Player profile
- Cash and lifetime revenue
- Hiring cost
- Business mode
- Processing queue and offline completion
- Brand multiplier validation
- Stomp multiplier bounds
- Delivery event idempotency
- Final sale revenue

## Economy contract

```text
Quality = serverBrandMultiplier × clampedStompMultiplier

DirectRevenue =
round(¥12 × Quality × BrokerMultiplier)

ProcessedRevenue =
round(¥12 × Quality × 1.72 × BrokerMultiplier)
```

`brandMultiplier` 由服务端根据 `brandId` 重新校验。客户端传值只用于一致性检查。

## Rendering strategy

- Orthographic isometric camera
- WebGPU preferred
- WebGL 2 fallback
- PBR materials with restrained metallic response
- Directional shadow map
- Edge rendering for graphic line identity
- Local mesh impact response; no global camera shake
- Procedural art assets in prototype
- glTF/KTX2/Draco migration path for production
- Quality tier controls hardware scaling and shadow resolution

## Commercial hardening

原型的 JSON repository 仅用于展示分层。商业生产环境应替换为：

- PostgreSQL: account, inventory, economy ledger
- Redis: session, rate limit, hot configuration
- Kafka/PubSub: telemetry and async economy events
- Object storage/CDN: glTF, KTX2, audio, localization
- Feature flags: remote balancing and A/B tests
- Signed configuration and anti-replay event protocol
