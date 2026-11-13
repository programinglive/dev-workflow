# Central Gateway Authorization Policy

**Version:** 1.0.0  

## Default-Deny Collection & Operation Guard

`evaluateGatewayToolPolicy({ toolName, collection, claims })` enforces:
1. **System Collection Block:** Any `pb_*` mutation or raw dump targeting `_superusers` or `activity_users` password hashes is unconditionally denied.
2. **Legacy Collection Block:** Any write targeting the retired `activity_tasks` collection is denied with a pointer to Zettly (Human Planning Plane) and DevWorkflow Core (`dev-workflow.db`).
3. **Destructive Action Gate:** `pb_delete_record` and `pb_create_collection` require an authenticated human principal and explicit capability allowance.
