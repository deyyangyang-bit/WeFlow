# Linux 中央节点部署步骤（Phase 3a 完整版）

> 适用场景：办公室 x86 机器装 Linux 当中央主机；**办公室断电纪律（人走断电）**，主机只在工作时间内在线。
> 依据：`docs/规划/中央节点采购方案.md`（电源/存储/常在线要求）、`central/TLS-部署说明.md`（验收契约）、
> `central/Dockerfile` 与 `docker-compose.central*.yml`（现有发布物）、`central/src/app.ts`（认证与绑定契约）。
> 核心简化：Linux 宿主上 Caddy 用 `network_mode: host`，真实 LAN 来源 IP 无 NAT 直达，
> `remote_ip` CIDR 天然成立——**不需要 Windows 原生 Caddy 交付层那套包装**。
> PRD 铁律「中央离线时销售端照常工作」保证工作时间内在线即可，不需要 24 小时开机。

---

## 0. 范围与前提

| 项 | 本文档覆盖 | 不覆盖 |
|---|---|---|
| 范围 | Phase 3a：PostgreSQL + Central 服务 + Caddy TLS + 设备绑定 + 双机验收 + 断电编排 + 备份 | Phase 3b WeKnora 知识库（未启动）；从 Windows 测试库迁移历史数据（如需，§13.5 附注） |

前提确认（开工前逐项勾选）：

- [ ] 机器：x86-64，建议双盘位（见采购方案 §2/§3.1）；Phase 3a 单盘可先跑，Phase 3b 前补齐双盘 RAID1
- [ ] 已确认**办公室断电的大致钟点**（自动关机要排在它之前，§11）
- [ ] 已确认办公网段 CIDR（如 `192.168.1.0/24`）与主机将使用的固定地址（DHCP 保留或静态）
- [ ] 有第二台 LAN 电脑做客户机验收（§10）

## 1. BIOS：电源自动化（人走断电的关键）

断电不是问题，**脏断电**（PostgreSQL 写入中拔电）才是。三条设置在 BIOS 里完成：

1. **来电自启**：找 `Restore on AC Power Loss`（Dell/HP）/ `After Power Failure`（Lenovo），设为 **Power On**。早上有人合闸，主机就自己醒来——这是每天早晨的默认开机方式。
2. **RTC 自动开机**（兜底）：设早上固定钟点（如 08:00）。用于"电没断、人先走"的夜晚，防止主机睡死。
3. 保存后验证一次：拔电再合闸，看主机是否自启。

## 2. 操作系统安装基线

1. 制作 Debian 12 / Ubuntu 24.04 LTS 安装 U 盘（有第二台在线机器即可，镜像从官网下载）。
2. 安装要点：
   - 主机名建议 `weflow-central`；
   - 创建管理员用户，安装时勾选 **OpenSSH server**；
   - 磁盘：单盘跑 Phase 3a 就用整盘 LVM/EXT4 默认分区；双盘位机型此时就配 mdadm RAID1（采购方案 §3.1）；
   - **不要装桌面环境**。
3. 网络地址固定：路由器上给主机网卡做 **DHCP 保留**（记下最终 IP，如 `192.168.1.60`），或主机静态 IP。这个地址就是 `central/proxy.env` 里的绑定地址。
4. 时间同步（TLS 与 SLA 时间戳都依赖准确时钟）：
   ```bash
   sudo timedatectl set-ntp true
   systemctl status systemd-timesyncd   # 确认已同步；夜间断网没关系，工作时段会追平
   ```
5. 防火墙基线（只开 SSH 与 443）：
   ```bash
   sudo apt install -y ufw
   sudo ufw allow 22/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

## 3. Docker Engine 安装

在线（办公网可达外网时）：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # 重新登录生效
docker version && docker compose version   # compose 插件 v2 自带
```

离线（办公网不可达外网）：在能联网的机器下载 `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-compose-plugin` 的 `.deb`（pgp 走官方仓库），U 盘拷贝后 `sudo apt install ./*.deb`。

## 4. 离线镜像包制作（在 Mac 开发机做）与传输

三个镜像全部 linux/amd64，构建/保存后用 U 盘或云盘目录（沿用现有 `云盘传输-*` 惯例）带到主机：

```bash
cd <仓库根目录>  # 本地 clone 的 WeFlow 根目录
GITSHA=$(git rev-parse --short HEAD)

# 1) central 应用镜像（Dockerfile 基于 node:22-alpine，构建在 linux/amd64 平台完成）
docker buildx build --platform linux/amd64 -f central/Dockerfile -t weflow-central:${GITSHA} --load .
docker save weflow-central:${GITSHA} | gzip > weflow-central-${GITSHA}.tar.gz

# 2) postgres 基础镜像
docker pull --platform linux/amd64 postgres:17.6-alpine
docker save postgres:17.6-alpine | gzip > postgres-17.6-alpine.tar.gz

# 3) caddy 基础镜像（若沿用现有交付包可跳过：WeFlow-caddy-2.11.4-amd64.tar.gz 即官方 linux/amd64 镜像）
docker pull --platform linux/amd64 caddy:2.11.4-alpine
docker save caddy:2.11.4-alpine | gzip > WeFlow-caddy-2.11.4-amd64.tar.gz

# 4) 校验清单（交付包惯例：SHA256SUMS.txt）
shasum -a 256 weflow-central-${GITSHA}.tar.gz postgres-17.6-alpine.tar.gz WeFlow-caddy-2.11.4-amd64.tar.gz > SHA256SUMS.txt
```

同时在 Mac 上把仓库里这些**配置文件**也拷到同一 U 盘（镜像构建不含它们）：

```
docker-compose.central.yml
docker-compose.central.tls-linux.yml      # 本仓库新增的 Linux host 模式变体
central/Caddyfile.linux                    # 本仓库新增（bind 收敛 + 127.0.0.1:8787 上游）
central/.env.example
central/proxy.env.example
central/secrets/                           # 目录本身（密码文件在 §5 现场生成，不打包）
```

主机端导入并核对：

```bash
mkdir -p ~/weflow && cd ~/weflow   # 发布目录，后续所有 compose 命令都在这里
# 拷入上述文件并保持目录结构
shasum -a 256 -c SHA256SUMS.txt
gunzip -c weflow-central-${GITSHA}.tar.gz | docker load
gunzip -c postgres-17.6-alpine.tar.gz     | docker load
gunzip -c WeFlow-caddy-2.11.4-amd64.tar.gz | docker load
docker images   # 应看到 weflow-central / postgres / caddy 三个
```

## 5. 发布目录与配置文件

在发布目录 `~/weflow`（下文所有 compose 命令都**在这个目录**、**同一个项目名**下执行）：

```bash
# 1) 数据库密码（secret，不进 Git）
mkdir -p central/secrets
openssl rand -hex 24 > central/secrets/postgres_password
chmod 600 central/secrets/postgres_password

# 2) central/.env（从模板改两处）
cp central/.env.example central/.env
#   - WEFLOW_CENTRAL_ADMIN_TOKEN：至少 32 随机字符（服务端硬校验，不足会拒绝启动）
openssl rand -hex 32   # 生成后填入
#   - 其余保持模板值；数据库 URL/密码文件路径与基础 compose 的注入一致，不用改

# 3) Caddy 的 proxy.env（三个值都必填；缺失时 docker compose config 非零退出，fail closed）
cp central/proxy.env.example central/proxy.env
#   WEFLOW_CENTRAL_HTTPS_BIND=192.168.1.60      ← §2 固定的主机地址
#   WEFLOW_CENTRAL_HOSTNAME=weflow-central.test ← 内部域名（无内部 DNS 就用客户机 hosts）
#   WEFLOW_CENTRAL_ALLOWED_CIDR=192.168.1.0/24  ← §2 确认的办公网段

# 4) 渲染自检（必须非零退出才算通过本步骤；空值会退化成监听全部接口，被这步拦住）
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml -f docker-compose.central.tls-linux.yml config > /dev/null && echo OK
```

⚠️ **项目名纪律**：项目名决定实际卷名（本项目 = `weflow_weflow-postgres`）。换目录、换名字都会指向另一套卷，
可能被误判"数据丢失"。本 Linux 主机是全新数据库，项目名用 `weflow`（区别于 Windows 测试的 `weflow-test`）。

## 6. 首次启动

```bash
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml -f docker-compose.central.tls-linux.yml up -d
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml -f docker-compose.central.tls-linux.yml ps
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml -f docker-compose.central.tls-linux.yml logs --tail 50 central caddy
```

预期状态：三个容器 Up；central 日志显示迁移应用（`migrations/001_initial.sql`、`002_central_projections.sql` 由
central 启动时自动执行，`schema_migration` 表记账）；无 Caddy 证书报错。

## 7. 验收清单（本机，全部通过才算部署完成）

沿用 `TLS-部署说明.md` 的既有契约，Linux 上逐条复验：

```bash
HOST=192.168.1.60   # 换成本机地址
# 1) 健康端点（本机回环直达 central 诊断口）
curl -s http://127.0.0.1:8787/health   # {"ok":true,...,"service":"weflow-central"}
curl -s http://127.0.0.1:8787/ready    # {"ok":true,"data":{"database":"ready"}} —— 数据库就绪

# 2) HTTPS 端点（此时客户机还没装根证书，先用 -k 做**部署自检**；正式接入禁止 --insecure）
curl -sk https://127.0.0.1/health -H "Host: weflow-central.test"   # 同 1)

# 3) 真实 LAN 来源判定（host 模式的核心收益）：从另一台 LAN 机器访问，
#    Caddy remote_ip 命中允许网段 → 200；否则 403。本机自测走 127.0.0.1 也应在 CIDR 外被 403。
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/health -H "Host: weflow-central.test"  # 403

# 4) 端口暴露面：只应有 22(SSH)、443(Caddy)、127.0.0.1:8787(诊断)
sudo ss -tlnp | grep -E ':(80|443|5432|8787)\b'
#   禁止出现 80/5432；8787 必须只绑定 127.0.0.1；443 由 Caddy host 模式持有

# 5) 卷与数据落点
docker volume ls | grep weflow    # weflow_weflow-postgres / weflow_caddy_data / weflow_caddy_config
```

## 8. 根证书分发与客户机接入

1. 取出**公开**根证书（根私钥留在 `weflow_caddy_data` 卷内，禁止导出）：
   ```bash
   docker run --rm -v weflow_caddy_data:/d alpine cat /d/pki/authorities/local/root.crt > weflow-central-root.crt
   ```
2. 客户机（第二台 LAN 电脑）：
   - 安装根证书到受信任根（macOS 钥匙串 / Windows certmgr.msc「受信任的根证书颁发机构」）；
   - 无内部 DNS 时在客户机 hosts 加 `192.168.1.60 weflow-central.test`；
   - **正常 TLS 校验，禁止 `--insecure`**（与 Windows 侧验收口径一致）。
3. 客户机验证：`curl --cacert weflow-central-root.crt https://weflow-central.test/health` → 200。

## 9. 工作区 / 员工建档与设备绑定

服务端只有 bootstrap-admin 一种运维身份（`central/src/app.ts` §二.7），工作区与员工档案先建、再发邀请：

```bash
# 1) 建工作区与员工（psql 直连容器；无工作区创建端点，建档走 SQL）
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml exec postgres \
  psql -U weflow -d weflow -c "
    INSERT INTO workspace (name) VALUES ('默认工作区') RETURNING id;"
# 记下返回的 workspace UUID，然后：
docker compose -p weflow --env-file central/proxy.env \
  -f docker-compose.central.yml exec postgres \
  psql -U weflow -d weflow -c "
    INSERT INTO employee (workspace_id, employee_code, display_name, role)
    VALUES ('<workspaceId>','S001','测试销售甲','sales') RETURNING id, display_name;"
# role 枚举：sales / supervisor / allocator / admin / service

# 2) bootstrap-admin 签发邀请码（响应体里 inviteCode 只出现一次，30 分钟过期）
export ADMIN_TOKEN=$(grep WEFLOW_CENTRAL_ADMIN_TOKEN central/.env | cut -d= -f2)
curl --cacert weflow-central-root.crt https://weflow-central.test/api/v1/bindings/invitations \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspaceId>","employeeCode":"S001","displayName":"测试销售甲","role":"sales"}'
```

3) 客户机在 WeFlow 客户端「绑定中央身份」里填邀请码完成 claim
   （POST `/api/v1/bindings/claim`，带 deviceName；服务端返回并保存 deviceToken）。
   绑定后本机归属别名 = 中央 displayName（销售视图可见性修复 §22 的机制）。
4) 每位销售重复 `INSERT employee` + 签发邀请 + 客户端绑定。

## 10. 双机业务验收

参考 `docs/实施记录/…§22.6 Windows 第二台复验指令`——客户机步骤相同，仅证书/hosts 换 Linux 主机地址：

- [ ] 分配端（分配员机）分配线索 → 中央 ACK=applied
- [ ] 销售机 pull 后，销售视图能看到该线索（署名或中央 displayName 别名命中）
- [ ] 中央回收（recycle）经 host 模式真实来源路径走通（Windows 上这是最难的一环，Linux host 模式天然成立）
- [ ] 销售机断网（中央不可达）照常录入，恢复后 outbox 补传成功

夹具级回归在任一开发机跑 `npx tsx scripts/central-identity-visibility-test.ts`（59/0 基线），与真机验收互补。

## 11. 人走断电的关机编排（Linux 侧）

1. 定时干净关机，**钟点必须早于办公室断电时间**（按实际断电钟点调整）：
   ```bash
   sudo tee /etc/systemd/system/weflow-nightly-shutdown.service >/dev/null <<'EOF'
   [Unit]
   Description=Weflow central nightly clean shutdown
   [Service]
   Type=oneshot
   ExecStart=/usr/sbin/poweroff
   EOF
   sudo tee /etc/systemd/system/weflow-nightly-shutdown.timer >/dev/null <<'EOF'
   [Unit]
   Description=Shutdown before office power-off
   [Timer]
   OnCalendar=*-*-* 21:30:00
   Persistent=true
   [Install]
   WantedBy=timers.target
   EOF
   sudo systemctl enable --now weflow-nightly-shutdown.timer
   systemctl list-timers | grep shutdown
   ```
   顺序即契约：**21:30 主机自己 poweroff → 之后人走断电只是"电源早没了"**，PostgreSQL 永远干净停机。
2. 如果断电钟点不固定：加小 UPS + NUT，掉电进电池 5 分钟内自动 `shutdown`（等价把 §1 的"合闸自启"
   和这里的"定时关机"换成"掉电自检 + 撑到 UPS 触发"）。
3. 演练一次真实循环：傍晚手动提前执行 `sudo systemctl start weflow-nightly-shutdown.service`，
   确认容器干净退出（`docker compose ps` 全部停止）；次日合闸后自启，`docker compose ps` 三容器自动 Up
   （`restart: unless-stopped` 已配好，Docker 服务自启：`sudo systemctl enable docker`）。
4. 断电演练一次：直接拉闸 → 合闸 → 核对 `/ready` 200、`docker compose logs postgres` 无恢复告警、业务数据完好。

## 12. 每日备份

```bash
sudo mkdir -p /var/backups/weflow
sudo tee /etc/systemd/system/weflow-backup.{service,timer} >/dev/null <<'EOF'
[Unit] Description=Weflow central nightly backup
[Service] Type=oneshot
ExecStart=/bin/sh -c 'cd ~/weflow && docker compose -p weflow --env-file central/proxy.env -f docker-compose.central.yml exec -T postgres pg_dump -U weflow weflow | gzip > /var/backups/weflow/weflow-$(date +%%F).sql.gz && find /var/backups/weflow -name "weflow-*.sql.gz" -mtime +14 -delete'
EOF
# timer 部分：OnCalendar=*-*-* 21:00:00（排在关机前 30 分钟），Persistent=true
sudo systemctl enable --now weflow-backup.timer
```

恢复演练至少做一次：`gunzip -c 备份 | docker exec -i <pg容器> psql -U weflow weflow`（先 drop/create 空库）。
Phase 3b 启动时按采购方案 §3.2 把备份目的地换到外部盘/异机。

## 13. 回退与排障

- **只回退 Caddy**：`docker compose ... stop caddy && docker compose ... rm -f caddy`（Central/PostgreSQL 不动）。
- **绝不执行 `down -v`**：会删除 `weflow_weflow-postgres` 等数据卷。
- 客户机 403：来源 IP 不在 `WEFLOW_CENTRAL_ALLOWED_CIDR`（host 模式下这是真实地址，改 env 后重启 caddy）。
- TLS 握手失败：先查主机时钟（`timedatectl`），再确认客户机装了根证书、hosts/DNS 指对地址。
- central 起不来：`.env` 的 ADMIN_TOKEN < 32 字符、密码文件缺失、迁移目录不在镜像内都会在启动日志里明说。
- 历史数据迁移（Windows `weflow-test` → 本机）：不在本步骤范围；如需，用 §12 的 pg_dump/restore 在两台机之间做一次，并保留 Windows 机只读以备核对。

---

### 与既有交付物的关系（变更摘要）

| 文件 | 状态 | 说明 |
|---|---|---|
| `docker-compose.central.tls-linux.yml` | **新增** | Linux host 模式 Caddy 变体；不与桥接网络混用，bind 交给 Caddyfile |
| `central/Caddyfile.linux` | **新增** | `bind {$WEFLOW_CENTRAL_HTTPS_BIND}` + `reverse_proxy 127.0.0.1:8787`；其余契约与 Windows 版逐行同构 |
| `docker-compose.central.yml` / `central/.env*` / 基础 Caddyfile | 未改动 | Windows/Docker Desktop 测试线继续可用 |
