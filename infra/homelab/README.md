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

DB CR은 `databaseReclaimPolicy: retain`이므로 매니페스트가 실수로 삭제돼도 데이터베이스는 유지됩니다.
이 저장소는 PostgreSQL만 지원합니다. 롤이나 DB를 제거해야 할 때는 앱과 durable worker를 먼저
중지하고, PostgreSQL 백업의 격리 복원과 연결 종료를 확인한 뒤 별도 변경으로 진행합니다.

## CNPG volume snapshot backup

운영 백업은 Rook Ceph RBD의 CSI `VolumeSnapshot`을 사용합니다. 적용 전에는 Ceph PG가 모두
`active+clean`인지, snapshot controller와 RBD snapshotter가 Ready인지 확인합니다. Ceph가
`HEALTH_WARN`이면 원인을 확인하고 disposable PVC의 write → snapshot → restore → checksum
rehearsal을 통과시킨 뒤에만 운영 DB에 연결합니다.

```bash
kubectl apply --dry-run=server \
  -f infra/homelab/cnpg-volume-snapshot-class.yaml
kubectl apply -f infra/homelab/cnpg-volume-snapshot-class.yaml

kubectl -n pg patch cluster pg-prod-block \
  --type=merge \
  --patch-file infra/homelab/cnpg-volume-snapshot-backup-patch.yaml \
  --dry-run=server
kubectl -n pg patch cluster pg-prod-block \
  --type=merge \
  --patch-file infra/homelab/cnpg-volume-snapshot-backup-patch.yaml
```

`rook-ceph-rbd-cnpg-managed`는 `deletionPolicy: Delete`를 사용하고, CNPG snapshot은 이를 만든
`Backup`이 소유합니다. 따라서 retention controller가 오래된 `Backup`을 삭제하면 Kubernetes
garbage collection이 `VolumeSnapshot`과 backend RBD snapshot까지 함께 제거합니다.

예약 백업은 `pg-prod-block-snapshot-daily`가 하루 한 번 생성하며 최근 성공한 7개만 보존합니다.
CNPG cron은 초를 포함한 6-field 형식이고 timezone 필드가 없으므로, 적용 후
`status.nextScheduleTime`이 의도한 Asia/Seoul 시각인지 확인해야 합니다. retention CronJob은
Kubernetes `timeZone: Asia/Seoul`을 명시합니다.

```bash
kubectl apply --dry-run=server \
  -f infra/homelab/cnpg-volume-snapshot-schedule.yaml
kubectl apply -f infra/homelab/cnpg-volume-snapshot-schedule.yaml

kubectl -n pg get scheduledbackup pg-prod-block-snapshot-daily -o yaml
kubectl -n pg get backup \
  -l cnpg.io/scheduled-backup=pg-prod-block-snapshot-daily
kubectl -n pg get volumesnapshot \
  -l cnpg.io/cluster=pg-prod-block
```

Retention은 완료된 백업만 생성시각과 이름으로 안정 정렬해 삭제합니다. 실행 중·실패한 백업,
다른 schedule과 수동 백업은 건드리지 않으며, 잘못된 timestamp나 Kubernetes API 오류가 있으면
삭제 없이 실패합니다. 전용 ServiceAccount는 `Backup`의 list/get/delete 권한만 갖습니다.
controller는 외부 패키지가 없는 non-root `scratch` 이미지이며 Harbor digest로 고정합니다.

```bash
docker build \
  --build-arg APP_GIT_SHA="$(git rev-parse HEAD)" \
  -t harbor.uaysk.com/toss-portfolio-lens/cnpg-backup-retention:git-"$(git rev-parse HEAD)" \
  infra/homelab/cnpg-backup-retention
```

Volume snapshot만으로는 외부 WAL archive나 PITR이 생기지 않습니다. `ContinuousArchiving=True`만
보고 durable PITR로 간주하지 않습니다. 별도 object-store plugin과 격리 PITR restore를 검증하기
전까지 이 정책은 최근 시점의 full snapshot 복구만 제공합니다. 기존 mode-600 logical dump는
독립 restore rehearsal을 두 번 통과할 때까지 보존합니다.
