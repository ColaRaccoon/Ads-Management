SELECT a.oid::text membership_oid,r.rolname parent,m.rolname member,g.rolname grantor,a.admin_option,a.inherit_option,a.set_option
FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
JOIN pg_roles g ON g.oid=a.grantor
WHERE m.rolname IN ('postgres','meta_ads_prod_migration','meta_ads_app') ORDER BY 1,2;
