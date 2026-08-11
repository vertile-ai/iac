# 部署清单与凭据物化

**状态：** Active  
**Owner：** `@vertile-ai/iac` implementation track  
**当前结果：** IAC 已能同步 env、reconcile Vercel/GitHub，也仍包含完整的 Terraform renderer、provider resource schema 和 lifecycle commands。Noop 正在把最后两个 Vertile-generated DigitalOcean Spaces states 迁入手写 Terraform。  
**下一 Gate：** 先冻结新边界和 manifest shape；等待 Noop staging/production Spaces state 完成无损迁移后，再删除本仓库的 Terraform product surface。

## 一、目标

把 `@vertile-ai/iac` 收敛成两个能力：

1. **部署清单：** `iac.json` 记录项目有哪些部署、使用什么工具和 provider、需要哪组 credentials。
2. **凭据物化与平台 reconciliation：** 从 `iac.json` 按最小 scope 生成工具可消费的 credential files，并继续承担 env、Vercel、GitHub 等 application/platform reconciliation。

IAC 不再：

- 抽象 Terraform resources；
- 生成 `.tf`；
- 包装 `terraform plan/apply/import/output/state`；
- 拥有 Terraform state、backend、locking 或 drift；
- 用 provider-neutral `objectStorage`、`services`、`databases` 等模型代替原生 Terraform。

一句话边界：

> `iac.json` 描述部署拓扑与 credential routing；Terraform 描述并管理基础设施资源。

## 二、绑定决策

### 2.1 `iac.json` 是私密输入

- repo root `iac.json` 是 operator-owned source of truth。
- 它可以直接保存 deployment、debugging、provider access credentials。
- 只要包含 credential value，它必须被 Git ignore，POSIX mode 必须为 `0600`。
- tracked `iac.example.json` 只保留结构、非敏感配置和 deterministic placeholders。
- 不再把 `.iac/private.json` 作为第二输入，也不再把 tracked `iac.json` 与 private overlay deep-merge。
- 本阶段不设计 KMS、secret manager、加密文件格式或 remote vault。

### 2.2 `.iac/` 是生成输出

`.iac/` 只存本机、私密、可重新生成的 IAC artifacts：

```text
repo/
├── iac.json                         # ignored private source of truth
├── iac.example.json                 # tracked safe template
└── .iac/                            # ignored generated output
    └── noop/                        # project key
        └── credentials/
            ├── terraform-staging.env
            ├── terraform-production.env
            ├── vercel.env
            └── github.env
```

规则：

- `.iac/` directory mode 为 `0700`；credential files mode 为 `0600`。
- output path 固定从 safe project key 和 credential profile key 推导。
- 不允许 `..`、absolute path 或任意 output override 穿出 `.iac/`。
- dry-run 只打印 profile、key names、target path 和 missing status，不打印 values。
- `.iac/` 不存 Terraform HCL、state、plan、provider cache 或 application runtime env。

### 2.3 Runtime env 与 deployment credentials 分离

| Namespace | 内容 | 消费者 |
| --- | --- | --- |
| `env.metadata` | application runtime/local development env values 与 package routing | app packages、Vercel env、local env files |
| `credentials` | operator、deployment、debugging、provider access keys | Terraform、Vercel CLI/API、GitHub CLI/API、project scripts |
| `deployments` | deployment inventory、tool、providers、working directory、credential profile | humans、validation、project-owned deployment scripts |

`credentials` 不会因为 key 名相同而自动进入 `env.metadata`。deployment credential 只有被 deployment/profile 显式选择时才能物化。

## 三、目标 Manifest

首个真实 consumer 使用 Noop。目标 shape 保持小，不设计通用 workflow engine：

```json
{
  "version": 3,
  "project": {
    "key": "noop",
    "name": "Noop"
  },
  "environments": ["local", "staging", "production"],
  "credentials": {
    "terraform-staging": {
      "values": {
        "DIGITALOCEAN_TOKEN": "<private>",
        "CLOUDFLARE_API_TOKEN": "<private>",
        "AWS_ACCESS_KEY_ID": "<private-backend-key>",
        "AWS_SECRET_ACCESS_KEY": "<private-backend-secret>"
      }
    },
    "terraform-production": {
      "values": {
        "DIGITALOCEAN_TOKEN": "<private>",
        "CLOUDFLARE_API_TOKEN": "<private>",
        "AWS_ACCESS_KEY_ID": "<private-backend-key>",
        "AWS_SECRET_ACCESS_KEY": "<private-backend-secret>"
      }
    },
    "vercel": {
      "values": {
        "VERCEL_TOKEN": "<private>"
      }
    },
    "github": {
      "values": {
        "GITHUB_TOKEN": "<private>"
      }
    }
  },
  "deployments": {
    "bff-staging": {
      "environment": "staging",
      "tool": "terraform",
      "providers": ["digitalocean", "cloudflare"],
      "workingDirectory": "infrastructure/terraform/environments/staging",
      "credentialProfile": "terraform-staging"
    },
    "bff-production": {
      "environment": "production",
      "tool": "terraform",
      "providers": ["digitalocean", "cloudflare"],
      "workingDirectory": "infrastructure/terraform/environments/production",
      "credentialProfile": "terraform-production"
    },
    "web-production": {
      "environment": "production",
      "tool": "vercel",
      "providers": ["vercel"],
      "apps": ["web-client", "auth", "preview"],
      "credentialProfile": "vercel"
    }
  },
  "providers": {
    "vercel": {
      "teamSlug": "example-team"
    },
    "github": {
      "repository": "owner/repo"
    }
  },
  "env": {
    "sourceDir": ".vertile-iac/env",
    "metadata": {}
  },
  "apps": []
}
```

### 3.1 `credentials`

- Key 是稳定 profile identifier。
- `values` 是工具最终收到的 environment-variable name/value map。
- Profile 本身不声明 Terraform resources、Vercel projects 或 GitHub repositories。
- 一个 profile 可以被多个 deployments 或 direct reconciliation commands 复用。
- 所有 credential values 都视为 secret；不增加重复的 `encrypted: true`。
- 空值在 materialize/apply 时失败；example manifest 可以使用明确 placeholder。

### 3.2 `deployments`

`deployments` 是 inventory，不是 deployment abstraction。

它可以表达：

- deployment key；
- logical environment；
- actual tool，例如 `terraform` 或 `vercel`；
- actual providers，例如 `digitalocean`、`cloudflare`、`vercel`；
- repo-relative working directory；
- credential profile；
- Vercel deployment 对应的 app keys。

它不能表达：

- Droplet、bucket、database、queue、network、firewall 等 resource shape；
- Terraform variables、backend config、resource address 或 import ID；
- deploy steps、retry、rollback、approval、state migration 或 workflow DAG；
- arbitrary shell commands。

真正的 Terraform configuration、backend 和 commands 继续放在 owning product repo。

### 3.3 `providers`

- 只保留 platform reconciliation 所需的非敏感 provider metadata，例如 Vercel team、GitHub repository。
- provider credentials 移到 named `credentials` profiles。
- DigitalOcean、Cloudflare、AWS 等如果只由 Terraform 使用，不需要 IAC provider adapter；它们只出现在 deployment inventory 的 `providers` 和 credential key names 中。
- 不提供 `providers.<name>.resources` generic escape hatch。

## 四、Credential Materialization Interface

新增一个小 CLI surface：

```sh
# Dry-run：只显示目标路径与 key names
vertile-iac credentials --profile=terraform-staging

# 写入 .iac/noop/credentials/terraform-staging.env
vertile-iac credentials --profile=terraform-staging --apply

# 物化 deployment 引用的 profile
vertile-iac credentials --deployment=bff-staging --apply
```

输出使用 dotenv-compatible `KEY=value`，正确 quote whitespace、quotes 和 newlines。首版只生成这一种格式。

Terraform 由 Noop 自己启动并读取该文件，例如 project-owned script：

```text
read .iac/noop/credentials/terraform-staging.env
inject exact key/value pairs into child process env
exec terraform -chdir=infrastructure/terraform/environments/staging plan
```

IAC 不提供 `deploy`、`terraform` wrapper 或任意 command execution。project script 负责加载 file、运行实际工具和传递 exit code。

Vercel/GitHub reconciliation 可以直接从 resolved credential profile 读取 token，不要求先落盘；只有 external tool/debugging flow 需要 credential file。

## 五、需要删除的 Terraform Surface

Noop 完成 Spaces state migration 后，一次 breaking slice 删除以下内容。

### 5.1 CLI 与 package bins

- `src/render.ts`
- `src/plan.ts`
- `src/apply.ts`
- `src/output.ts`
- `vertile-iac render|plan|apply|output`
- `vertile-iac-render`
- `vertile-iac-plan`
- `vertile-iac-apply`
- `vertile-iac-output`
- flags：`--out`、`--target`、`--deployment`、`--terraform-bin`、`--yes`、`--migrate-state`、`--reconfigure`、Terraform `--json` output mode

### 5.2 Renderer 与 Terraform core

- `src/core/render.ts`
- `src/core/terraform.ts`
- `src/core/hcl.ts`
- `src/core/concepts.ts`
- `src/core/deployments.ts`；由新的 deployment-inventory parser 取代，不保留 provider render semantics
- `src/providers/aws/`
- `src/providers/digitalocean/`
- `src/providers/vercel/` 中 Terraform renderer；Vercel API reconciliation 保留在现有 core/command modules
- `targetWorkspace`、`generatedRoot`、`terraformBin` 和 Terraform-specific args parsers

### 5.3 Manifest/schema concepts

- `objectStorage`
- `services`
- `databases`
- queues 和其他 provider-neutral infrastructure resource arrays
- `providers.aws`
- `providers.digitalocean`
- provider `resources`
- provider deployment/backend/state fields
- resource-specific AWS、DigitalOcean 和 Terraform `$defs`

保留：`project`、`environments`、`env`、`apps`、`domains`、Vercel/GitHub reconciliation metadata；新增收敛后的 `credentials` 和 deployment inventory。

### 5.4 Tests

删除或重写纯 renderer suites：

- `test/multi-provider.test.ts`
- `test/digitalocean-services-render.test.ts`
- `test/output-command.test.ts`
- `test/services-manifest.test.ts`
- `test/core-coverage.test.ts` 中 target/workspace/Terraform args coverage
- `test/shared.test.ts` 与 schema fixtures 中 portable resource coverage

新增 focused tests：

- private `iac.json` tracked/not-ignored/mode rejection；
- credential profile validation；
- deployment/profile/app/environment references；
- safe output path；
- dotenv escaping；
- dry-run 和 error 不泄露 secret sentinel；
- exact profile scope，不把其他 profile values 写入同一文件；
- Vercel/GitHub credential resolution 使用 named profiles；
- version 3 schema 拒绝已删除的 Terraform concepts。

### 5.5 Examples 与 docs

- 删除 example 中 `iac.aws.json`、`iac.do.json`、Terraform render scripts 和仅证明 renderer 的 examples。
- 保留并收敛 env/Vercel/GitHub examples。
- 增加一个 Noop-shaped deployment inventory + credential materialization example，所有 secrets 使用 placeholders。
- 重写 `README.md`、`README.zh-CN.md`、`docs/README.md`、`docs/manifest.md`、`docs/positioning.md`、`docs/roadmap.md` 和 `docs/index.html`。
- 重新生成 `docs/schema/iac-manifest.schema-doc.json`。
- 修改 package description，不再宣传 portable Terraform for AWS/DigitalOcean。
- 修改项目 `AGENTS.md`，把产品职责从 portable infrastructure renderer 改为 deployment manifest、credential materialization、env 和 platform reconciliation。

## 六、保留的能力

- `vertile-iac validate`
- `vertile-iac sync-env`
- `vertile-iac env`
- `vertile-iac github-actions`
- `vertile-iac projects`
- `vertile-iac domains`
- env source/metadata/routing
- Vercel project/domain/env reconciliation
- GitHub Actions secret/variable reconciliation
- safe `iac.example.json` generation contract，由 product repo 或后续 shared command 承担

现有 Vercel build-setting reconciliation 可以继续深化，因为它是 platform configuration reconciliation，不是 Terraform resource abstraction。

## 七、交付顺序

### Gate 0 — Noop state ownership 完成

- Noop staging/production Spaces buckets 已 import 到手写 Terraform state。
- 两边 reviewed plan 都没有 create、replace 或 destroy。
- Noop runtime env bridge 已读取 native Terraform outputs。
- Noop 不再调用 Vertile `render/plan/apply/output`。
- 整个 `noop-build` workspace 搜索不到 Vertile Terraform command consumer。

**Exit：** 可以删除 renderer，而不会丢失 live infrastructure owner。

### Gate 1 — Credential contract tests

- 先写 version 3 schema、private manifest、credential profile、deployment inventory 和 safe materialization 的失败测试。
- 用一个最小 Noop-shaped fixture 固定目标 layout 和 dry-run output。
- 明确 version 1/2 compatibility 是否仍有真实 consumer；没有真实 consumer时直接 breaking replacement，不构建 migration framework。

**Exit：** focused tests 只因新 parser/materializer 尚未实现而失败。

### Gate 2 — Parser 与 materializer

- 实现 version 3 manifest normalization/validation。
- 实现 exact-profile credential materialization。
- 创建 `.iac/<project>/credentials/<profile>.env`，保证 directory/file modes。
- 实现 dry-run、apply 和 non-leaking errors。
- 简化 private value resolution；删除 `.iac/private.json` overlay path。

**Exit：** Noop fixture 生成可被 child-process env loader 消费的 Terraform credential file。

### Gate 3 — 迁移 surviving adapters

- Vercel、GitHub commands 从 named credential profile 获取 token。
- env sync 继续只读取 `env.metadata`，不读取 deployment credentials。
- `validate` 同时验证 env routing 和 deployment/profile references。
- 保持现有 dry-run/apply remote mutation boundary。

**Exit：** env、Vercel、GitHub focused tests 通过；secret sentinel 不出现在 stdout/stderr。

### Gate 4 — 删除 Terraform abstraction

- 按第五节删除 code、schema、commands、tests、examples。
- 简化 `context.ts` 与 `args.ts`，保留 repo/manifest resolution 和通用 flags。
- 确认 package artifact 不再包含 provider renderer 或 Terraform executable path。

**Exit：** `rg` 找不到 runtime Terraform renderer/lifecycle implementation；version 3 schema 拒绝旧 resource concepts。

### Gate 5 — Noop real run

- 把 Noop ignored `iac.json` 迁移到新 credentials/deployments shape。
- 生成 staging Terraform credential file。
- 由 Noop project-owned script 加载 file 并运行 real staging `terraform plan`。
- 运行 Vercel/GitHub dry-run 和 env sync。
- production credential materialization 与 Terraform plan 需要独立审批。

**Exit：** 一个 `iac.json` 能支持 native Terraform、Vercel、GitHub 和 env workflows，但 IAC 没有执行或抽象 Terraform。

### Gate 6 — Docs 与 breaking release

- 完成 docs、examples、schema docs、package metadata 和 changelog。
- 发布 breaking version；当前 `0.2.1` 下默认目标为 `0.3.0`。
- Noop 更新 dependency/lockfile并复跑 Gate 5 proofs。

**Exit：** package positioning 与真实能力一致，没有 portable infrastructure claims。

## 八、安全不变量

1. 包含 credential values 的 `iac.json` 必须 ignored 且 mode `0600`。
2. `.iac/` 必须 ignored；credential file mode `0600`。
3. dry-run、error、logs、tests、example manifest 不打印 credential values。
4. credential materialization 只写 selected profile。
5. Terraform credentials 通过 child process environment 使用，不生成 `tfvars`，不写进 Terraform configuration。
6. Terraform 是否把 provider-returned data 写进 state 仍由 Terraform/provider contract 负责；IAC 不读取或改写 state。
7. runtime env 与 deployment credentials 默认不互通。
8. 删除 local credential output 只删除精确 profile file；不提供 recursive cleanup command。

## 九、完成标准

- `iac.json` 是 deployment topology、runtime env metadata 和 credentials 的唯一 private source。
- `.iac/<project>/credentials/*.env` 可从 `iac.json` 重建。
- Native Terraform 能使用生成 credentials，同时独立拥有 `.tf`、backend、state、plan 和 apply。
- Vercel/GitHub adapters 使用同一 credential profile model。
- IAC 不包含 Terraform renderer、provider resources 或 lifecycle commands。
- Manifest 不包含 `objectStorage`、`services`、`databases` 等 infrastructure abstractions。
- Noop staging real plan、env sync、Vercel/GitHub dry-runs 通过。
- `npm test` 与 `npm run check` 通过。
- docs、examples、schema、package description 与新边界一致。

## 十、明确不做

- 不创建 secret manager、credential rotation service 或 encrypted vault。
- 不把 `.iac/` 做成 Terraform working directory。
- 不替 Terraform 生成 provider blocks、resources、variables、backend 或 imports。
- 不执行 arbitrary deployment commands。
- 不设计 generalized driver/plugin framework。
- 不为没有真实 consumer 的 provider 预建 credential adapter。
- 不保留无人消费的 Terraform compatibility layer。
