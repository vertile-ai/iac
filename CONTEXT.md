# Deployment Configuration Context

This context defines how a project declares deployment intent and routes private values without replacing native infrastructure tools.

## Language

**Public Manifest**:
The tracked `iac.json` that declares project intent, credential slots, and consumer routing without private values.
_Avoid_: Private manifest, credential vault

**Project-Local Private Store**:
The single ignored `.iac/private.json` beside the owning project's `iac.json`, containing all declared private values for that project.
_Avoid_: Global private store, workspace credential root, parent credential store

**Credential Slot**:
A reviewable declaration in `iac.json` naming a private value required by a consumer.
_Avoid_: Credential value, secret

**Credential Value**:
The actual private value in the Project-Local Private Store that fills one declared Credential Slot.
_Avoid_: Slot, declaration

**Credential Profile**:
A named set of Credential Slots selected together for one deployment or platform operation.
_Avoid_: Environment, provider configuration

**Deployment Credential**:
A Credential Value consumed by an operator, CI job, debugging tool, or deployment tool rather than an application runtime.
_Avoid_: Runtime env value

**Runtime Env Value**:
A private or public value routed through `env.metadata` into an application or package environment.
_Avoid_: Deployment credential

**Deployment Inventory**:
A manifest record identifying an existing deployment entry point, its real tool, logical environment, and Credential Profile without modeling resources or execution steps.
_Avoid_: Deployment engine, workflow, resource model

**Credential Projection**:
A scoped mapping of one Credential Profile into a consumer's process environment or required file format.
_Avoid_: Deployment, secret store

## Relationships

- A **Public Manifest** declares zero or more **Credential Slots** and groups them into **Credential Profiles**.
- A **Project-Local Private Store** supplies exactly one **Credential Value** for each configured private **Credential Slot**.
- A **Deployment Inventory** entry may select one **Credential Profile**.
- A **Credential Projection** resolves one selected **Credential Profile** from one **Project-Local Private Store**.
- A **Deployment Credential** never becomes a **Runtime Env Value** without explicit runtime routing in the **Public Manifest**.

## Example dialogue

> **Dev:** "Where does the DigitalOcean token live for the staging Terraform plan?"
> **Domain expert:** "`iac.json` declares its Credential Slot and staging profile; this repo's `.iac/private.json` holds the Credential Value. No parent credential store is searched."

## Flagged ambiguities

- "Credential in `iac.json`" means a **Credential Slot** and its routing, not a plaintext **Credential Value**.
- "Top-level `.iac`" means the owning project repo's `.iac/`, not a workspace-level directory containing per-project stores.
- "Credential" previously mixed runtime secrets with deployment access; these remain **Runtime Env Values** and **Deployment Credentials** with distinct routing.
