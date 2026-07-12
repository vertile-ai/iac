# @vertile-ai/iac

[English](README.md)

把基础设施意图、环境变量和部署阶段放进一个可审查的文件，再用同一套命令生成 Vercel、AWS 或 DigitalOcean 所需的 Terraform 工作区。`@vertile-ai/iac` 适合不希望在脚本、控制台和多个配置文件之间重复维护应用名称、域名、环境与云厂商设置的产品团队。

它把应用代码与基础设施连接成一个可靠的协作流程：

- 开发者在代码旁的 `iac.json` 中描述产品需要什么。
- 审阅者可以在同一个 PR 中看到应用与基础设施的变化。
- CI 为每个云厂商和部署阶段生成可复现的 Terraform，而不是依赖手动配置的状态。
- 统一 manifest 可以逐步接管既有的 Vercel 环境变量、项目设置、域名和 GitHub Actions 工作流。

实际效果是：改域名、环境或部署阶段时只改一个经过审查的文件，不必把同一配置复制到多个云控制台。

## 从这里开始

在产品仓库中安装：

```bash
pnpm add -D @vertile-ai/iac
```

在仓库根目录新建 `iac.json`（也兼容旧位置 `infrastructure/iac/iac.json`），先渲染，再 plan 或 apply：

```bash
pnpm exec vertile-iac render --target=all --env=production
pnpm exec vertile-iac plan --target=aws --env=production
pnpm exec vertile-iac apply --target=aws --deployment=prod --yes
```

`render` 不需要网络，也不会调用 Terraform；输出在 `.vertile/terraform/<provider>/`。`plan` 与 `apply` 需要 Terraform。为避免误操作，非交互式 `apply` 必须显式传入 `--yes`，它会向 Terraform 传递 `-auto-approve`。在运行 `plan` 或 `apply` 前，仍需按 Terraform 的常规方式配置所选云厂商的凭证。首次成功的 `render` 会生成例如 `.vertile/terraform/aws/main.tf` 的文件；请先检查这些文件，再执行 plan。

## 一个真正有用的最小 manifest

下面的配置为一个 Web 应用定义 Vercel 项目和 AWS S3 bucket，同时让环境模型保持可移植：

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json",
  "version": 1,
  "project": { "name": "acme" },
  "environments": {
    "development": { "files": [".env.development"] },
    "staging": { "files": [".env.staging"] },
    "production": { "files": [".env.production"] }
  },
  "providers": {
    "vercel": { "teamSlug": "acme" },
    "aws": { "region": "ap-southeast-2" }
  },
  "apps": [{
    "key": "web",
    "name": "acme-web",
    "framework": "nextjs",
    "rootDirectory": "apps/web",
    "domains": ["app.example.com"]
  }],
  "objectStorage": [{ "key": "uploads", "visibility": "private" }]
}
```

包内提供 `schema/iac.schema.json`；将 `$schema` 指向它即可获得编辑器补全与校验。

## 在执行时选择云厂商

manifest 保存的是可移植的产品意图，命令的 target 决定采用哪个云厂商实现，而不需要改变应用配置：

| 目标 | 命令 |
| --- | --- |
| 审阅生成配置 | `vertile-iac render --target=all --env=staging` |
| 规划单一云厂商 | `vertile-iac plan --target=vercel --env=production` |
| 应用指定阶段 | `vertile-iac apply --target=aws --deployment=prod --yes` |

支持 `vercel`、`aws`、`digitalocean` 和 `all`。输出稳定可复现，因此本地和 CI 得到的是同一份 plan。

`deployments` 可将 `uat`、`nightly`、`prod` 等团队阶段名映射为逻辑环境和云厂商特定参数：

```json
{
  "providers": {
    "aws": {
      "region": "ap-southeast-2",
      "deployments": {
        "prod": {
          "environment": "production",
          "profile": "acme-production",
          "tags": { "Stage": "production" }
        }
      }
    }
  }
}
```

该命令会输出到 `.vertile/terraform/aws/prod/`；环境文件仍按映射后的逻辑环境选择。

## 用一处规则管理环境变量

默认将环境变量源文件放在 `.vertile-iac/env`：

```text
.vertile-iac/env/shared/.env.production
.vertile-iac/env/web/.env.production
```

`environments.<name>.files` 中的文件名（例如 `.env.production`）会相对于上述每个源目录选择，并不是另一套放在仓库根目录的约定。只有开始使用 `sync-env` 或远端 reconciliation 命令时才需要创建这些 env 文件；最小 manifest 的 Terraform render 不依赖它们。

在 `iac.json` 的 `env.metadata` 中声明元数据。CLI 可据此从同一个来源生成各应用或包所需的 `.env` 文件、Vercel 环境变量以及 GitHub Actions 的环境变量或 secret。值的归属与可投放位置因此不必在三个系统中重复维护。

```bash
vertile-iac sync-env --variants=local,staging,production
vertile-iac env --scope=all --targets=preview,production
vertile-iac github-actions --env=staging
```

后两个命令默认只 dry-run，传入 `--apply` 才会变更远端。Vercel apply 支持 `VERCEL_TOKEN`、`VERCEL_API_KEY`、`providers.vercel.token` 或 `providers.vercel.apiKey`；进程环境变量优先。

## 兼容既有 Vercel 工作流

现有团队可以逐步采用统一 manifest：

```bash
vertile-iac env --repo-root .
vertile-iac projects --repo-root .
vertile-iac domains --repo-root .
```

这些命令从 `iac.json` 推导所需的 Vercel 状态。仅为兼容性保留显式的 `project-settings.json` 与 `project-domains.json`；新项目应使用统一 manifest。

## manifest 中应放什么

`apps`、`domains`、`objectStorage`、`databases`、`queues`、`sandboxes` 和 `clusters` 描述产品需求。当可移植模型尚未覆盖某个资源时，使用 `providers.<target>.resources` 作为云厂商专属扩展；通过 provider deployment 添加阶段差异，而不是复制整份 manifest。

完整字段说明与可运行示例：

- [Manifest 指南](docs/manifest.md)
- [Schema 文档](docs/schema/iac-manifest.schema-doc.json)
- [可运行示例](examples/)
- [产品方向与当前范围](docs/roadmap.md)

## 开发

项目以 TypeScript 编写，并在 `dist/` 中发布编译后的 ESM：

```bash
pnpm install
pnpm run check
pnpm test
```

`pnpm test` 会先构建，再执行仓库的覆盖率门槛。
