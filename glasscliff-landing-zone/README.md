# Glasscliff Landing Zone

A small, hand-written Azure landing zone: a management group hierarchy,
guardrail policies, central logging, a budget, and read access for the site.
The identity lab's subscription moves under it as the first governed workload.

This deliberately does **not** use Microsoft's ALZ accelerator. Its default
policy set includes deploy-if-not-exists policies that switch on paid services
(Defender plans, for example), which is right for a company and a surprise bill
for a personal subscription. Every guardrail here is one I chose and can explain.

## What gets built

```
Tenant root
└── Glasscliff                  baseline guardrails assigned here
    ├── Platform
    ├── Landing Zones
    │   └── Online              the identity lab's subscription
    ├── Sandbox
    └── Decommissioned
```

Guardrails, defined in `2-platform.bicep` (one initiative, `glasscliff-baseline`, all starting in **Audit**; the tag list is fixed in the initiative, so adding a tag means adding an entry there):

| Rule | Why |
|---|---|
| Resources only in allowed regions (`eastus2`) | Data residency and cost control; global resources exempt |
| Every resource tagged `owner` and `environment` | Cost and incidents need somewhere to go |
| No standalone public IP addresses | The usual way a VM ends up on the internet by accident |
| Storage requires HTTPS and TLS 1.2 | No plain-HTTP or old-TLS access to data |

Also: a Log Analytics workspace (`rg-glasscliff-platform`, 30-day retention,
1 GB/day cap), the subscription activity log exported to it, a monthly budget
with alerts at 50% and 80% actual and 100% forecast, and Reader for wetcliff at
the Glasscliff management group so the site can show the platform live.

Cost: management groups, policy, RBAC and budgets are free. Log Analytics at
lab volume is a few dollars a month at most. No hub network, no firewall.

## Deploy

### 1. Management groups (needs temporary tenant-wide rights)

Creating management groups under the tenant root and moving a subscription
out of it needs rights at `/`. Even a Global Admin doesn't have those by
default; you elevate, grant yourself Owner at `/`, deploy, then remove both.

```bash
ME=$(az ad signed-in-user show --query id -o tsv)
SUB=$(az account show --query id -o tsv)

# elevate (Global Admin only) and take Owner at the root, temporarily
az rest --method post --url "/providers/Microsoft.Authorization/elevateAccess?api-version=2016-07-01"
az role assignment create --assignee "$ME" --role Owner --scope /

az deployment tenant what-if -l eastus2 -f 1-management-groups.bicep -p workloadSubscriptionId=$SUB
az deployment tenant create  -l eastus2 -f 1-management-groups.bicep -p workloadSubscriptionId=$SUB -n glasscliff-mg

# keep Owner on the Glasscliff group only, then drop the root elevation
az role assignment create --assignee "$ME" --role Owner --scope /providers/Microsoft.Management/managementGroups/glasscliff
az role assignment delete --assignee "$ME" --role Owner --scope /
az role assignment delete --assignee "$ME" --role "User Access Administrator" --scope /
az role assignment list --assignee "$ME" --scope / -o table   # should be empty
```

Before dropping the root elevation, give yourself Owner on the Glasscliff
management group itself. Azure only makes the creator of a management group its
Owner when they don't already inherit Owner from above; while elevated at `/`
you did, so no assignment was made, and without this step deployment 2 fails
with AuthorizationFailed:

```bash
az role assignment create --assignee "$ME" --role Owner \
  --scope /providers/Microsoft.Management/managementGroups/glasscliff
```

### 2. Guardrails, logging, budget

Copy `platform.parameters.example.json` to `platform.parameters.json` (it is git-ignored) and fill in the subscription id, alert email and web app principal id, then:

```bash
az deployment mg what-if --management-group-id glasscliff -l eastus2 -f 2-platform.bicep -p @platform.parameters.json
az deployment mg create  --management-group-id glasscliff -l eastus2 -f 2-platform.bicep -p @platform.parameters.json -n glasscliff-platform
```

### Guardrails on one resource group instead of the whole group

A management-group assignment covers every subscription beneath it, which gets in
the way when other work shares the subscription. To apply the same guardrails to
named resource groups only, list them (they must already exist):

```bash
az deployment mg create --management-group-id glasscliff -l eastus2 -f 2-platform.bicep \
  -p @platform.parameters.json -p assignmentResourceGroups='["rg-glasscliff-lab"]' -n glasscliff-platform
```

The initiative stays at the management group; only the assignment moves down. If
a management-group assignment already exists, remove it first so the two don't
overlap: `az policy assignment delete -n glasscliff-baseline --scope /providers/Microsoft.Management/managementGroups/glasscliff`.

Then tell the site where to ask. A policy on one resource group is only evaluated
for requests made at that resource group, so the "try to break the rules" check
needs the same scope. Set `LZ_POLICY_RESOURCE_GROUP` on the web app to the first
name in the list:

```bash
az webapp config appsettings set -g rg-basic-webapp -n wetcliff --settings LZ_POLICY_RESOURCE_GROUP=rg-glasscliff-lab
```

### 3. Read the findings

Policy evaluation takes up to about 30 minutes after assignment. Then:

```bash
az policy state summarize --management-group glasscliff \
  --query "value[0].policyAssignments[0].policyDefinitions[].{rule:policyDefinitionReferenceId, nonCompliant:results.nonCompliantResources}" -o table

az policy state list --management-group glasscliff --filter "complianceState eq 'NonCompliant'" \
  --query "[].{rule:policyDefinitionReferenceId, resource:resourceId}" -o table
```

Expect the identity lab's own resources to show up: they were built before
these rules existed, and most are probably missing the `owner` and
`environment` tags. That's the point of starting in Audit. Fix or consciously
accept each finding before switching to Deny.

### 4. Switch to Deny (later, deliberately)

```bash
az deployment mg create --management-group-id glasscliff -l eastus2 -f 2-platform.bicep \
  -p @platform.parameters.json -p policyEffect=Deny -n glasscliff-platform
```

Deny only affects new and updated resources; existing non-compliant ones keep
running but stay flagged.

## Honest limitations

- One subscription. A real landing zone puts platform services (logging,
  identity, connectivity) in their own subscriptions under Platform. Here the
  workspace lives in a resource group in the workload subscription. The
  hierarchy is built so a second subscription can drop in without rework.
- No hub network. Hub-and-spoke with a firewall is the expensive part of a
  landing zone and not needed for this lab's workloads.
- No Privileged Identity Management; that needs an Entra ID P2 license.

==== October 12th, 2026 ===
Currently the policy is down. I'm making some edits to the site, so any resources set will "work".
