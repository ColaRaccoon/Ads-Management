import { TARGET } from './core.mjs';

// Credential rotation must apply new variables without rebuilding unchanged code.
export async function replaceTokenAndDeploy(railway, token) {
  const scope = { p: TARGET.projectId, e: TARGET.environmentId, s: TARGET.serviceId };
  const current = await railway('query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){activeDeployments{id status}}}', scope);
  const deployments = current.serviceInstance?.activeDeployments ?? [];
  if (deployments.length !== 1 || !['SUCCESS', 'SLEEPING', 'CRASHED'].includes(deployments[0].status)) {
    throw Error('DEPLOYMENT_BASELINE_UNAVAILABLE');
  }
  const updated = await railway('mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}', {
    input: { projectId: scope.p, environmentId: scope.e, serviceId: scope.s, replace: false,
      skipDeploys: true, variables: { SUPABASE_STORAGE_ACCESS_TOKEN: token } }
  });
  if (updated.variableCollectionUpsert !== true) throw Error('UPDATE_OUTCOME_UNKNOWN_INSPECT_NO_RETRY');
  const result = await railway('mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}', { id: deployments[0].id });
  if (!result.deploymentRedeploy?.id) throw Error('DEPLOYMENT_OUTCOME_UNKNOWN_INSPECT_NO_RETRY');
  return true;
}
