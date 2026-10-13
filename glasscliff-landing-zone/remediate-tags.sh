#!/usr/bin/env bash
# Tags the resources the Sep 21 2026 policy scan found non-compliant.
#
# Uses `az tag update --operation Merge`, which calls the Microsoft.Resources/tags
# extension API directly and only ever touches tags. `az resource tag` instead
# round-trips the whole resource (read it, merge tags in, write it back), and
# on the App Service Certificate that failed with a keyVaultId validation
# error, because that property doesn't round-trip cleanly through the CLI.
# `az tag update` never reads or resends properties like keyVaultId, so this
# is both simpler and safer for resource types with linked-resource fields
# (certificates, some managed identities).
#
# Values used:
#   owner=antalon                          matches every other Glasscliff resource
#   rg-glasscliff-lab      environment=dev  matches the tag already on its siblings
#                                           (main.parameters.json: "environment": "dev")
#   rg-basic-webapp        environment=prod wetcliff is the live public site; change
#                                           this if you'd rather call it something else
set -euo pipefail

# Your subscription id. Not committed: az account show --query id -o tsv
SUB="${SUBSCRIPTION_ID:?set SUBSCRIPTION_ID to the workload subscription id}"

tag() { az tag update --resource-id "$1" --operation Merge --tags owner=antalon environment="$2" -o none; }

# rg-glasscliff-lab (environment=dev)
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.web/serverfarms/asp-glasscli-dev-fkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.storage/storageaccounts/stglassclidevfkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.web/sites/func-glasscli-dev-fkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.operationalinsights/workspaces/log-glasscli-dev-fkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.managedidentity/userassignedidentities/id-func-glasscli-dev-fkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.keyvault/vaults/kv-glasscli-dev-fkompq" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.insights/actiongroups/application insights smart detection" dev
tag "/subscriptions/${SUB}/resourcegroups/rg-glasscliff-lab/providers/microsoft.insights/components/appi-glasscli-dev-fkompq" dev

# rg-basic-webapp (environment=prod)
tag "/subscriptions/${SUB}/resourcegroups/rg-basic-webapp/providers/microsoft.web/serverfarms/asp-rgbasicwebapp-8b24" prod
tag "/subscriptions/${SUB}/resourcegroups/rg-basic-webapp/providers/microsoft.web/sites/wetcliff" prod
tag "/subscriptions/${SUB}/resourcegroups/rg-basic-webapp/providers/microsoft.web/certificates/glasscliff.online-wetcliff" prod
tag "/subscriptions/${SUB}/resourcegroups/rg-basic-webapp/providers/microsoft.managedidentity/userassignedidentities/oidc-msi-aa38" prod

echo "Tagged 12 resources. Re-checking compliance now (results can take a few minutes to update)..."
# On-demand scans only exist at subscription or resource-group scope; there is
# no management-group trigger-scan. The two resource groups above cover every
# finding, so triggering both is enough (the list below still reads at the
# management group, which az policy state list does support).
az policy state trigger-scan --resource-group rg-glasscliff-lab -o none
az policy state trigger-scan --resource-group rg-basic-webapp -o none
sleep 90
az policy state list --management-group glasscliff --filter "complianceState eq 'NonCompliant'" \
  --query "[].{rule:policyDefinitionReferenceId, resource:resourceId}" -o table
