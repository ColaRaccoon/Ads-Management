Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$taskRaw=$null;$taskParsed=$null
try {
 $taskRaw=& 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' usage --json 2>&1
 if($LASTEXITCODE -ne 0){throw 'USAGE_READ_FAILED'}
 $taskText=$taskRaw -join "`n";if($taskText.Length -gt 1048576){throw 'USAGE_BOUND'}
 $taskParsed=$taskText|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 if($taskParsed.isCurrentPeriod -cne $true -or $taskParsed.usageLimit.softLimit -ne 7 -or $taskParsed.usageLimit.hardLimit -ne 10){throw 'USAGE_SCOPE_OR_LIMIT'}
 $taskWorkspace=[string]$taskParsed.workspace.id
 $taskWorkspaceHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskWorkspace))).ToLowerInvariant()
 if($taskWorkspaceHash -cne '3abd02fccdc76988858759e11c2b477db3706646bc247981dffcb630abd420da'){throw 'WORKSPACE_BINDING'}
 $taskOut=[ordered]@{kind='PHASE10_FINAL_CURRENT_RAILWAY_USAGE';at=[DateTimeOffset]::UtcNow.ToString('o');scope='CLI_SELECTED_WORKSPACE_AGGREGATE_NOT_ISOLATED_PROJECT_ONLY';workspaceIdSha256=$taskWorkspaceHash;currentUsageDollars=$taskParsed.currentUsageDollars;currentBillDollars=$taskParsed.currentBillDollars;estimatedBillDollars=$taskParsed.estimatedBillDollars;isCurrentPeriod=$true;billingPeriod=$taskParsed.billingPeriod;period=$taskParsed.period;usageLimit=@{softLimit=$taskParsed.usageLimit.softLimit;hardLimit=$taskParsed.usageLimit.hardLimit;isOverLimit=$taskParsed.usageLimit.isOverLimit};forecastIsNotAGuarantee=$true;settingsChanges=0;rawValuesReturned=0}
 foreach($taskName in @('currentUsageDollars','currentBillDollars','estimatedBillDollars')){if($null -eq $taskOut[$taskName] -or -not [double]::IsFinite([double]$taskOut[$taskName]) -or [double]$taskOut[$taskName] -lt 0){throw 'COST_NUMBER'}}
 $taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskOut|ConvertTo-Json -Depth 6));$taskFile=[IO.File]::Open('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v4/railway-usage.json',[IO.FileMode]::CreateNew);try{$taskFile.Write($taskBytes)}finally{$taskFile.Dispose()}
 @{kind=$taskOut.kind;currentUsageDollars=$taskOut.currentUsageDollars;estimatedBillDollars=$taskOut.estimatedBillDollars;settingsChanges=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='PHASE10_FINAL_CURRENT_RAILWAY_USAGE';status='SAFE_REJECTION';errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;rawValuesReturned=0;settingsChanges=0}|ConvertTo-Json -Compress;exit 1}
finally{$taskRaw=$null;$taskParsed=$null;$taskText=$null;$taskWorkspace=$null}
