# Homelab CNPG database

운영 앱은 `pg/pg-prod-block`의 전용 롤·DB를 사용합니다. 비밀번호는 저장소에 두지 않고 Kubernetes Secret에서만 관리합니다.

```bash
kubectl --context kubernetes-admin@kubernetes -n pg create secret generic toss-portfolio-lens-db \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=toss_portfolio_lens \
  --from-literal=password="$(openssl rand -base64 36)"

kubectl --context kubernetes-admin@kubernetes -n pg patch cluster pg-prod-block \
  --type=merge --patch-file infra/homelab/cnpg-managed-role-patch.yaml
kubectl --context kubernetes-admin@kubernetes apply -f infra/homelab/cnpg-database.yaml
```

호스트의 Docker Compose 앱은 RW LoadBalancer IP를 CNPG 인증서의 DNS SAN인 `pg-prod-block-rw.pg.svc.cluster.local`에 매핑합니다. `scripts/configure-cnpg-production.mjs`는 현재 Service IP와 `pg-prod-block-ca` Secret의 `ca.crt`를 조회해 비추적 `.env`의 `POSTGRES_DOCKER_HOST_IP`, PostgreSQL 연결값과 `data/certs/cnpg-ca.crt`를 구성합니다. 실제 내부 IP와 credential은 저장소에 기록하지 않습니다.

DB CR은 `databaseReclaimPolicy: retain`이므로 매니페스트가 실수로 삭제돼도 데이터베이스는 유지됩니다. 롤/DB를 제거할 때는 앱을 먼저 SQLite 또는 MariaDB로 전환하고 백업과 연결 종료를 확인해야 합니다.
