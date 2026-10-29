SELECT jsonb_build_object(
 'auditCount',(SELECT count(*) FROM meta_ads.unified_mapping_audits),
 'uiRuleUpdate',(SELECT jsonb_build_object('entityType',entity_type,'entityId',entity_id,'action',action,'actorUserId',actor_user_id,
 'beforeVersion',"before"->'version','afterVersion',"after"->'version',
 'sameBusinessConfiguration',("before"-'version'-'updatedAt')=("after"-'version'-'updatedAt'),'createdAt',created_at)
 FROM meta_ads.unified_mapping_audits
 WHERE reason='11단계 운영 UI 저장·감사·재집계 경로 검증; 기존 조건·금액 유지'
 ORDER BY created_at DESC LIMIT 1),
 'runStatusCounts',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT status,count(*),min(attempts) AS minimum_attempts,max(attempts) AS maximum_attempts FROM meta_ads.unified_aggregation_runs GROUP BY status ORDER BY status) x)
) AS audit;
