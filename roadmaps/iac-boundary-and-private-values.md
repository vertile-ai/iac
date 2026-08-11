# IAC 边界收敛与私密值分离

**状态：** Active  
**目标：** 让 `iac.json` 成为可追踪、可审查的唯一基础设施与环境意图来源，同时把敏感值放入严格受限、不可追踪的私密值文件；深化已经被真实项目证明的 IAC interface，不继续抽象 Terraform resource lifecycle。

## 一、核心决定

IAC 不维护两份可以互相覆盖的 manifest，而是维护一个逻辑配置的两个互斥所有权区：

```text
tracked iac.json
  ├─ project / environments / apps / domains / resources
  ├─ provider 非敏感配置
  ├─ env metadata、routing、example 和非敏感 values
  └─ 声明哪些变量是 encrypted

untracked .vertile-iac/private.json
  ├─ encrypted env values
  └─ 明确允许的 provider credentials
```

合并后的 resolved configuration 只存在于进程内。IAC 不生成一份包含全部秘密的第三个 manifest，也不把私密值写入 Terraform、日志、错误信息或 tracked artifacts。

### 所有权不变量

1. `iac.json` 是唯一可审查意图来源，拥有结构、路由、资源和所有非敏感值。
2. `.vertile-iac/private.json` 不是 partial manifest，只能为 `iac.json` 中已经声明为 `encrypted: true` 的变量提供值，或提供 adapter 明确允许的 provider credential。
3. 私密文件不能新增变量、改变 package routing、覆盖非敏感值、改变 provider region、app、domain 或 resource。
4. 同一个字段只有一个 owner；不存在任意 deep merge，也不存在“private wins everything”。
5. 进程环境中的 credential 保持最高优先级：`process env > private file > legacy inline credential`。legacy inline 只用于迁移兼容。
6. Terraform 继续拥有 plan、saved plan、apply、import、state、locking 和 drift；IAC 只生成配置并提供已有的命令便利层。
7. `iac.json` version 2 启用严格分离语义；version 1 保持读取兼容，但不得成为新项目模板。

## 二、目标文件格式

### Tracked `iac.json`

现有 manifest 结构尽量不变。非敏感变量继续在 metadata entry 中携带 `values`；敏感变量只保留描述和路由，不携带真实值。

```json
{
  "version": 2,
  "project": { "name": "noop" },
  "environments": ["local", "staging", "production"],
  "providers": {
    "vercel": {
      "teamSlug": "jazelly-github"
    }
  },
  "env": {
    "metadata": {
      "bff": {
        "variables": [
          {
            "key": "BFF_PUBLIC_ORIGIN",
            "encrypted": false,
            "packages": ["bff"],
            "values": {
              "local": "http://localhost:4302",
              "staging": "https://api-beta.noop.build",
              "production": "https://api.noop.build"
            }
          },
          {
            "key": "AUTH_INTERNAL_SECRET",
            "encrypted": true,
            "packages": ["bff"],
            "example": "<AUTH_INTERNAL_SECRET>"
          }
        ]
      }
    }
  }
}
```

### Untracked `.vertile-iac/private.json`

私密文件使用 keyed object，避免对 `variables[]` 做位置相关或任意数组合并。

```json
{
  "version": 1,
  "env": {
    "bff": {
      "AUTH_INTERNAL_SECRET": {
        "local": "example-local-only-value",
        "staging": "<private>",
        "production": "<private>"
      }
    }
  },
  "providers": {
    "vercel": {
      "token": "<private>",
      "protectionBypassForAutomation": {
        "ensure": {
          "secret": "<private>"
        }
      }
    }
  }
}
```

私密 schema 默认只允许：

- `env.<source-key>.<variable-key>.<environment>`；
- `providers.vercel.token` / `apiKey`；
- `providers.vercel.protectionBypassForAutomation.ensure.secret`；
- `providers.github.token`；
- 后续 adapter 只有在出现真实消费者时才能增加自己的 credential allowlist。

DigitalOcean、AWS 和 Terraform backend credentials 继续来自进程环境，不进入 manifest 或私密文件，也不进入 Terraform state。

## 三、IAC 内部 module 形状

新增一个深 module 作为唯一解析 seam：

```text
tracked manifest + optional private values + process environment
                              │
                              ▼
                    resolved IAC context
                 ┌────────────┴────────────┐
                 ▼                         ▼
          public manifest          private value access
       render / schema / plan      env sync / remote adapters
```

外部 CLI interface 不因分离而增加必填参数。manifest version 2 固定启用 split mode，默认私密路径为 `.vertile-iac/private.json`；私密文件不存在时 public render 仍可工作，需要私密值的命令按现有 missing/blank 语义处理。manifest version 1 保持 legacy inline-values 读取兼容。

resolved context 必须分别暴露：

- 可安全传给 renderer 的 public manifest；
- 按 source、key、environment 查询的 encrypted value accessor；
- 按 provider 查询的 credential accessor。

不得把 private values deep-merge 回普通 manifest object，因为普通 object 之后可能被打印、序列化或传给 Terraform renderer。

## 四、安全与失败规则

任何读取私密文件的命令都必须执行以下检查：

1. 在 Git repository 内，如果私密文件已经 tracked，立即失败。
2. 在 Git repository 内，如果私密文件没有被 ignore，立即失败并指出应加入的精确路径。
3. POSIX 上拒绝 group/world-readable 的私密文件；目标 mode 为 `0600`。
4. 私密文件出现未知 source、未知 variable、未知 environment 或非 encrypted variable 时失败。
5. 私密文件出现非 allowlist provider 字段时失败。
6. version 2 tracked manifest 中的 encrypted entry 出现 `values` 时失败；version 1 legacy inline values 继续读取并给出迁移警告。
7. 错误只打印 JSON path、变量 key 和 environment，不打印值。
8. `render` 及 Terraform HCL 输出在没有私密文件时仍然确定性一致。

缺少可选 integration 的私密值继续遵循现有 optional/blank 语义。本阶段不引入新的 required-variable 系统。

## 五、交付顺序

### Slice 1：契约测试与 schema

先写失败测试，再写实现。

- 增加 private-values schema 和 parser fixtures。
- 覆盖合法 encrypted value resolution。
- 覆盖 private 覆盖非敏感值、未知 key、未知 environment 和 provider 越权字段。
- 覆盖 tracked / not-ignored / unsafe-mode 文件拒绝。
- 覆盖所有错误和 dry-run 输出不包含测试 secret sentinel。
- 证明 version 1 没有私密文件时现有 manifest、render 和 CLI 行为不变。
- 证明 version 2 即使没有私密文件，也不会接受 tracked encrypted values 或悄悄退回 legacy mode。

**Exit：** 新测试失败原因只来自尚未实现的 resolver；现有最小测试保持通过。

### Slice 2：Resolved context

- 实现 public manifest、encrypted accessor 和 credential accessor。
- `sync-env`、`validate`、Vercel env/projects/domains 和 GitHub Actions sync 改为经过同一个 resolver。
- 保持 credential precedence：process env、private、legacy inline。
- renderer 只收到 public manifest。
- 不改变 Terraform plan/apply/state interface。

**Exit：** focused node tests、`npm test` 和 `npm run check` 通过；secret sentinel 不出现在 render、stdout、stderr 或生成 Terraform 中。

### Slice 3：Noop 真实迁移

这是本工作的第一个真实消费者验收，不先迁移其他示例项目。

1. 从当前 ignored version 1 `iac.json` 一次性提取 encrypted env values 和允许的 provider credentials。
2. 生成安全的 tracked version 2 `iac.json` 和 mode `0600` 的 `.vertile-iac/private.json`。
3. 在 Noop `.gitignore` 中精确忽略 `/.vertile-iac/private.json`。
4. 比较迁移前后所有 package env 输出；非敏感内容必须一致，敏感内容只比较 hash/存在性，不打印值。
5. 运行 Noop `env:sync`、`validate`、Vercel/GitHub dry-run 和现有最小相关测试。
6. 证明 tracked `iac.json` 不包含从旧 manifest 收集到的任何敏感 sentinel。
7. tracked `iac.json` 稳定后，删除 Noop 的整份-manifest 脱敏生成器和冗余 `iac.example.json`；本地安全默认值由一个小型 Noop-owned bootstrap adapter 写入 private 文件。
8. Noop 私密备份如果继续需要，只备份 `.vertile-iac/private.json`；备份调度仍归 Noop，不进入通用 IAC。

**Exit：** 新 clone 可以从 tracked `iac.json` 启动本地流程；真实 operator checkout 可以通过 private 文件生成与迁移前等价的 staging/production env；Git diff 中没有 secret。

### Slice 4：深化现有 interface

分离稳定后再做两个独立的小改动：

1. 把 Noop 的 Vercel `framework`、`installCommand`、`buildCommand`、`outputDirectory` reconciliation 收进现有 `projects` module，并删除 Noop 特殊脚本。
2. 让 Noop Spaces runtime reconciler 消费 `vertile-iac output --json`，不再直接解析 `terraform.tfstate`；output 到 BFF env key 的 mapping 继续归 Noop。

**Exit：** 两个 Noop glue scripts 明显缩小或删除，IAC CLI interface 没有新增 Terraform lifecycle 概念。

### Slice 5：定位与 roadmap 收敛

- 文档把 env、Vercel reconciliation、GitHub Actions projection、validation 和 safe output 标为 stable core。
- object storage 保留为有真实消费者的 portable concept。
- services、databases 标为 experimental。
- queues、sandboxes、clusters 暂停扩张和成熟能力宣传。
- Noop D0.9 service import handoff 移入 backlog；手写 BFF Terraform 与 IAC Spaces state 保持分离。

**Exit：** README、positioning、roadmap 与真实消费者使用情况一致，不再暗示 IAC 取代 Terraform。

## 六、明确不做

- 不设计通用 secret manager、加密文件格式或 KMS integration。
- 不让 private 文件任意覆盖 manifest。
- 不把 private values 写入 Terraform variables、state 或 generated HCL。
- 不实现 queue、retry、backup framework、state migration framework 或 control plane。
- 不把 Noop 的 Terraform、Ansible、release、rollback 或 Gunner runner lifecycle 内化进 IAC。
- 不为了 Noop D0.9 补齐一套与手写 Terraform 等复杂的 `services` schema。

## 七、完成标准

这项规划完成时必须同时满足：

- `iac.json` 可安全 tracked、review 和复制；
- private 文件只能填充已声明的敏感槽位；
- 每个字段只有一个 owner；
- Noop 本地、staging、production env materialization 行为等价；
- remote dry-run 行为等价且不泄露 secret；
- Terraform render 在有无 private 文件时完全一致；
- Gunner、Terraform、Ansible 和 Noop 的既有所有权不变；
- 没有新增抽象来重复 Terraform 已经成熟解决的问题。

## 八、本轮 Mission Contract

### Goal

仅在 `@vertile-ai/iac` 中完整交付 version 2 tracked/private 分离和已经确认应内化的 IAC 能力；完成后先汇报，不修改 Noop。

### V1 boundary

一个 version 2 consumer 能通过现有 CLI 自动发现 `.vertile-iac/private.json`，从 tracked metadata 与 private encrypted values 生成正确 env 输出；renderer 永远只消费 public manifest。Vercel/GitHub adapter 能从同一个 private seam 获取 allowlisted credential。Noop adaptation 延后。

### Assertions

- `PV-001`：version 2 tracked manifest 加合法 private 文件通过 `sync-env` 生成包含 public 和 encrypted values 的 package env。
- `PV-002`：version 2 tracked manifest 拒绝 inline encrypted `values`，并且有无 private 文件的 Terraform render 完全一致。
- `PV-003`：private 文件拒绝未知 source、variable、environment、非 encrypted override 和非 allowlist provider 字段；错误不包含 secret sentinel。
- `PV-004`：Git 内 tracked 或未 ignore 的 private 文件被拒绝；POSIX group/world-readable 文件被拒绝。
- `PV-005`：现有 version 1 manifest 与 CLI 测试继续通过；version 1 inline credential 仅作为兼容 fallback。
- `PC-001`：credential precedence 为 process environment、private file、version 1 inline credential、legacy token file；Vercel 与 GitHub mutating command 经过同一个 credential seam。
- `VP-001`：现有 `projects` command reconciliation 覆盖 `framework`、`installCommand`、`buildCommand`、`outputDirectory`。
- `DOC-001`：package 发布 version 2 manifest schema 与 private-values schema，README、manifest guide、positioning 和 roadmap 与实际 stable/experimental scope 一致。

### Evidence

- 每个行为先用最小 `node --test` focused test 完成 red-green cycle。
- `npm test`。
- `npm run check`。
- 独立 reviewer 只读检查最终 diff，并从 CLI interface 复验 assertions。

### Stop condition

以上 assertions 全部有本地证据、review verdict 为 approved、相关改动形成一个最终 commit；或者出现需要 Noop 数据/权限才能解决的真实 blocker 时停止并汇报。
