# 部署清单、凭据路由与 Terraform 抽象移除

**状态：** Active — design review 进行中  
**Owner：** `@vertile-ai/iac` implementation track  
**当前结果：** Version 2 已实现 tracked `iac.json` 与 ignored
`.iac/private.json` 的严格分离；Noop 正把最后两个 Vertile-generated
DigitalOcean Spaces states 迁入手写 Terraform。  
**下一 Gate：** 完成产品边界审查，冻结 credential projection 和 deployment
inventory 的最小行为，再开始代码变更。

## 一、已确认的产品边界

### 1.1 Public intent 与 private values 已经分离

这是现有能力，不重新设计：

```text
repo/
├── iac.json                 # tracked、reviewable intent
└── .iac/
    └── private.json         # ignored、0600、actual private values
```

`iac.json` 负责：

- 声明项目需要哪些 credentials；
- 声明 credential 属于哪个 provider、operation 或 deployment consumer；
- 声明 environments、apps、env metadata 和 platform reconciliation intent；
- 提供不含真实 secret 的 schema、example 和 review surface。

`.iac/private.json` 负责：

- 为 `iac.json` 已声明的 encrypted runtime values 提供实际值；
- 为 `iac.json` 已声明的所有 credential slots 提供实际 credential values，
  包括 Vercel/GitHub tokens、Terraform provider/backend credentials、其他
  DevOps 和 debugging access；
- 不能新增 deployment、provider、app、env routing 或 credential slot；
- 不能任意 deep-merge 或覆盖 public intent。

Private store 固定为 owning project repo 内的 `.iac/private.json`。Resolver 从
包含当前 `iac.json` 的 repo root 定位它，不向 workspace parent、monorepo parent
或用户目录搜索，也不增加 `.iac/<project>/private.json` 层级。一个项目只有一个
private store。

Process environment 可以继续作为显式 operator/CI override；resolved value
precedence 仍是：

```text
explicit process credential > .iac/private.json > supported legacy fallback
```

本 roadmap 不把 credential values 放进 `iac.json`，也不把整个 `iac.json`
变成 ignored private file。

### 1.2 Terraform 是唯一 infrastructure resource language

- Native `.tf` 定义所有 provider resources。
- Terraform 拥有 plan、saved plan、apply、import、state、backend、locking、
  output 和 drift。
- IAC 不生成 HCL，不抽象 resource shape，不包装 Terraform lifecycle。
- IAC 可以声明某个 deployment 使用 Terraform以及它需要哪些 credential
  slots，但不能描述该 Terraform stack 内部资源。

### 1.3 IAC 保留 application/platform reconciliation

保留现有真实消费者：

- env metadata、routing 和 package env materialization；
- Vercel env、project settings 和 domains reconciliation；
- GitHub Actions secrets/variables reconciliation；
- private-value safety、validation 和 safe examples。

这些能力是否能被 Terraform provider 实现，不是唯一判断标准。保留原因是：

- 它们已经有真实 consumer；
- env 与 secret reconciliation 不应把 secret values写入 Terraform state；
- 它们是 manifest 到 platform configuration 的 projection，不是
  provider-neutral resource model。

## 二、需要精确定义的术语

| Term | 定义 |
| --- | --- |
| Deployment credential | 只用于 operator、CI、debugging 或 deployment tool 的 private value，例如 `DIGITALOCEAN_TOKEN`；默认不进入 application runtime env |
| Runtime env value | 由 `env.metadata` 路由到 app/package/runtime 的值，例如 BFF 的 database URL 或 Spaces access key |
| Credential slot | `iac.json` 中可 review 的 required key declaration，不包含 private value |
| Credential value | owning project 的 `.iac/private.json` 中为已声明 slot 提供的实际 private value |
| Project-local private store | 与 owning `iac.json` 同一 repo root 下唯一的 `.iac/private.json`；不从父目录继承 |
| Deployment inventory | 描述一个已存在 deployment entry point 使用哪个真实 tool、environment 和 credential set；不描述执行步骤或 resources |
| Credential projection | 把 selected private credential values 映射为 consumer 所需的 process env 或 file format |

关键不变量：同一个字符串可能技术上都是 secret，但它的 owner 由 consumer
决定。`DIGITALOCEAN_TOKEN` 是 deployment credential；BFF 使用的 S3 access key
是 runtime env value。IAC 不因为它们都是 credentials 就把两个 namespace 合并。

## 三、目标 Manifest Shape

下面是待通过 Noop 真实 consumer 验证的最小 shape：

```json
{
  "version": 2,
  "project": {
    "key": "noop",
    "name": "Noop"
  },
  "environments": ["local", "staging", "production"],
  "credentialProfiles": {
    "terraform-staging": {
      "keys": [
        "DIGITALOCEAN_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY"
      ]
    },
    "terraform-production": {
      "keys": [
        "DIGITALOCEAN_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY"
      ]
    },
    "vercel": {
      "keys": ["VERCEL_TOKEN"]
    },
    "github": {
      "keys": ["GITHUB_TOKEN"]
    }
  },
  "deployments": {
    "bff-staging": {
      "environment": "staging",
      "tool": "terraform",
      "credentialProfile": "terraform-staging"
    },
    "bff-production": {
      "environment": "production",
      "tool": "terraform",
      "credentialProfile": "terraform-production"
    },
    "web-production": {
      "environment": "production",
      "tool": "vercel",
      "apps": ["web-client", "auth", "preview"],
      "credentialProfile": "vercel"
    }
  },
  "providers": {
    "vercel": {
      "teamSlug": "example-team",
      "credentialProfile": "vercel"
    },
    "github": {
      "repository": "owner/repo",
      "credentialProfile": "github"
    }
  },
  "env": {
    "metadata": {}
  },
  "apps": []
}
```

对应 private values：

```json
{
  "version": 1,
  "credentials": {
    "terraform-staging": {
      "DIGITALOCEAN_TOKEN": "<private>",
      "CLOUDFLARE_API_TOKEN": "<private>",
      "AWS_ACCESS_KEY_ID": "<private>",
      "AWS_SECRET_ACCESS_KEY": "<private>"
    },
    "terraform-production": {
      "DIGITALOCEAN_TOKEN": "<private>",
      "CLOUDFLARE_API_TOKEN": "<private>",
      "AWS_ACCESS_KEY_ID": "<private>",
      "AWS_SECRET_ACCESS_KEY": "<private>"
    },
    "vercel": {
      "VERCEL_TOKEN": "<private>"
    },
    "github": {
      "GITHUB_TOKEN": "<private>"
    }
  }
}
```

这个 shape 仍需通过后续 design review 验证。当前未确认：

- `deployments` 是否应包含 `workingDirectory`；
- Terraform deployment 是否需要显式 `providers`，还是 `.tf` 已经是唯一事实；
- credential projection 默认直接注入 process env，还是持久化生成 files；
- Vercel Git deployment 与 Vercel configuration reconciliation 是否应该共享
  `deployments` 术语。

未解决前，不实现这些字段。

## 四、Credential Projection 候选边界

### 方案 A — Direct process injection

```text
iac.json declaration
        +
.iac/private.json values
        │
        ▼
selected child-process environment
```

优点：不在磁盘复制 plaintext secrets，不产生 stale generated files。缺点：需要
一个极小的 `credentials exec` seam，或者每个 product repo 自己加载 resolved
profile。

### 方案 B — Generated credential files

如果真实工具或 debugging workflow 需要文件，输出必须与 private source 分区：

```text
.iac/
├── private.json                         # canonical private input
└── generated/
    └── credentials/
        ├── terraform-staging.env
        └── vercel.env
```

优点：Terraform、CLI 和人工调试容易消费。缺点：同一 secret 在磁盘出现两份，
存在 stale、rotation 和误用风险。

### 当前推荐

- Direct process injection 是默认路径。
- 只有出现必须读取文件的真实 consumer，才显式 materialize selected profile。
- Generated path 使用 `.iac/generated/credentials/<profile>.env`，不与
  `.iac/private.json` 混淆。
- IAC 不执行 deploy workflow；`credentials exec` 如果保留，只负责把 selected
  environment交给一个明确 command，不理解 Terraform。

这个推荐需要产品确认，尚未成为 binding decision。

## 五、Deployment Inventory 的产品约束

`deployments` 只有被真实行为消费才值得存在。单纯作为无法验证的说明字段，会与
Terraform、Vercel 和 project scripts drift。

它允许表达：

- stable deployment key；
- logical environment；
- actual tool；
- selected credential profile；
- 对 Vercel reconciliation 有意义的 app keys。

它不允许表达：

- provider resources；
- arbitrary shell commands；
- Terraform backend、variables、resource addresses、imports；
- rollout steps、approval、retry、rollback 或 DAG；
- tool-specific fields that no IAC command validates or consumes。

每个保留字段必须至少由一个真实 command、validation rule 或 consumer 使用。

## 六、需要删除的 Terraform Product Surface

Noop 完成 Spaces state migration 后，删除：

### CLI 与 bins

- `src/render.ts`
- `src/plan.ts`
- `src/apply.ts`
- `src/output.ts`
- `vertile-iac render|plan|apply|output`
- `vertile-iac-render|plan|apply|output` bins
- Terraform-specific flags：`--out`、`--target`、`--deployment`、
  `--terraform-bin`、`--yes`、`--migrate-state`、`--reconfigure`

### Implementation

- `src/core/render.ts`
- `src/core/terraform.ts`
- `src/core/hcl.ts`
- `src/core/concepts.ts`
- 当前 provider-render deployment resolver
- `src/providers/aws/`
- `src/providers/digitalocean/`
- `src/providers/vercel/` Terraform renderer
- `targetWorkspace`、`generatedRoot`、`terraformBin` 和 Terraform args parsers

### Manifest/schema

- `objectStorage`
- `services`
- `databases`
- queues 和其他 provider-neutral infrastructure resources
- `providers.aws`
- `providers.digitalocean`
- provider `resources`
- provider renderer deployments/backends/state fields
- AWS、DigitalOcean、Terraform resource `$defs`

### Tests/examples/docs

- 删除或重写 `multi-provider`、`digitalocean-services-render`、
  `output-command`、`services-manifest` tests。
- 删除 AWS/DO render examples 和 `iac:render` scripts。
- 重写 README、manifest、positioning、roadmap、static docs、schema docs、
  package description 和 `AGENTS.md`。
- 保留 private values、env、Vercel、GitHub、validation tests 与 examples。

## 七、交付顺序

### Gate 0 — 完成 design review

- 逐项解决第四、五节的 open decisions。
- 每个决定以 Noop 的具体 staging/production/debugging scenario 检验。
- 不为 hypothetic providers 或 credential formats 增加 fields。

**Exit：** credential projection 与 deployment inventory 具有一个最小、可运行、
无重复 source-of-truth 的 contract。

### Gate 1 — Noop 迁移 live Terraform state

- staging/production Spaces buckets 进入手写 Terraform state。
- reviewed plans 不包含 create、replace 或 destroy。
- runtime env bridge 读取 native Terraform outputs。
- Noop 不再消费 Vertile Terraform commands 或 state。

**Exit：** 删除 renderer 不会留下无 owner 的 live resource。

### Gate 2 — Contract tests

- 先写 credential slot、private value、profile selection、reference validation、
  non-leaking output 的失败测试。
- 如果确认 file materialization，再加入 safe path、mode、dotenv escaping 和 exact
  profile scope tests。
- 保留现有 tracked/private separation tests。

**Exit：** focused tests 只因新 contract 尚未实现而失败。

### Gate 3 — Credential routing

- 扩展现有 resolved context，而不是建立第二套 secret resolver。
- Vercel/GitHub commands 通过 declared credential profiles 获取 token。
- env sync 继续只消费 `env.metadata` private values。
- 完成一个 Noop staging credential consumer 的真实 run。

**Exit：** 新 routing 带来真实 consumer value，且没有 secret leakage 或重复 owner。

### Gate 4 — 删除 Terraform abstraction

- 按第六节删除 code、schema、tests、examples 和 docs。
- 简化 `context.ts`、`args.ts` 和 package bins。
- Manifest validator 明确拒绝已删除的 infrastructure concepts。

**Exit：** package artifact 不包含 Terraform renderer、provider resource model 或
lifecycle wrapper。

### Gate 5 — Product reconciliation proof

- Noop env sync。
- Vercel projects/domains/env dry-runs。
- GitHub Actions dry-run。
- Native Terraform staging plan 使用 resolved credential profile。
- production credential use 与 Terraform plan 需要独立审批。

**Exit：** IAC 支持部署与配置所需 credential routing，但 Terraform 仍是唯一
infrastructure authority。

### Gate 6 — Breaking release

- 更新 docs、examples、schemas、changelog、package metadata 和 project rules。
- 当前 `0.2.1` 下默认 breaking target 为 `0.3.0`。
- Noop 更新 dependency/lockfile并重复 Gate 5。

## 八、安全不变量

1. Tracked `iac.json` 不包含 private credential values。
2. `.iac/private.json` ignored、untracked，POSIX mode `0600`。
3. Private file 只能填充 public manifest 已声明的 slots，但它是 runtime、
   platform、Terraform 和其他 DevOps credentials 的统一 private store。
4. Runtime env values 与 deployment credentials 不自动互通。
5. Dry-run、errors、logs、examples 和 generated docs 不打印 secrets。
6. Terraform credentials 只能作为 process env 或显式 consumer-required file；不生成
   `tfvars`，不写 Terraform configuration。
7. IAC 不读取、复制、迁移或改写 Terraform state。
8. 如果生成 credential file，只生成 selected profile，并明确标为 derived output。

## 九、完成标准

- `iac.json` 仍是 tracked、reviewable deployment and reconciliation intent。
- `.iac/private.json` 仍是 actual private values 的唯一 canonical local input。
- Private resolver 只读取 owning repo 的 `.iac/private.json`，不搜索或继承任何
  parent-level credential store。
- Credential slots、profiles 和 consumers 在 `iac.json` 中可见且可验证。
- 没有 second secret resolver 或任意 private overlay。
- Native Terraform 独立拥有 resources、plan、apply、import、state 和 output。
- IAC 不包含 Terraform renderer 或 provider-neutral infrastructure resources。
- Env、Vercel、GitHub 与一个 native Terraform credential consumer 通过真实验证。
- `npm test` 与 `npm run check` 通过。

## 十、明确不做

- 不把 raw credentials 放进 `iac.json`。
- 不删除或替代已实现的 `.iac/private.json` boundary。
- 不增加 workspace-level `.iac/<project>` credential hierarchy。
- 不创建 vault、KMS、rotation service 或 secret manager。
- 不把 credential routing 扩张成 generalized deployment engine。
- 不替 Terraform 生成或维护任何 infrastructure resource configuration。
- 不保留无人消费的 Terraform compatibility layer。
