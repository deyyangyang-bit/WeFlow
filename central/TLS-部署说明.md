# Central 临时内网 TLS 层

本文件是 Windows 内网临时测试的最小操作说明。它只覆盖 Caddy 反向代理，不替换或重建现有
Central / PostgreSQL；现有 `central/.env`、数据库 secret、数据卷和业务数据继续由 Central
部署维护，不能复制给 Caddy。

## 交付内容

- `docker-compose.central.tls.yml`：在既有 `docker-compose.central.yml` 上增加 Caddy。
- `central/Caddyfile`：只监听 HTTPS 443，使用 Caddy 内部 CA，拒绝允许网段之外的直接 peer。
- `central/proxy.env.example`：当前临时测试值；实际文件名必须是 `central/proxy.env`，该文件不入 Git。
- `WeFlow-caddy-2.11.4-amd64.tar.gz`：Docker Hub 官方 `caddy:2.11.4-alpine` 的 linux/amd64 离线镜像。

## 统一命令前缀

以下所有操作都必须在**现有 Central 发布目录**（即已存在 `central/.env`、
`central/secrets/postgres_password` 与 Central 数据卷的那份 `docker-compose.central.yml` 所在目录）
中执行，并始终使用**同一个项目名** `weflow-test` 与**同一组配置文件**：

```powershell
docker compose -p weflow-test --env-file central/proxy.env `
  -f docker-compose.central.yml -f docker-compose.central.tls.yml <子命令>
```

固定项目名是必须的：项目名决定实际卷名（`weflow-test_weflow-postgres`）。换名字或换目录都会
指向另一套卷，可能被误当成"数据丢失"。

## Windows 测试机操作

1. 先导入离线镜像：

   ```powershell
   docker load --input WeFlow-caddy-2.11.4-amd64.tar.gz
   ```

2. 在现有发布目录中复制 `central/proxy.env.example` 为 `central/proxy.env`，仅填写本机内网 HTTPS
   绑定地址、测试域名和允许网段。当前测试值是 `192.168.1.57`、`weflow-central.test`、
   `192.168.1.0/24`；正式使用前必须改为 DHCP 保留地址、内部 DNS 名称和经过确认的办公网段。

   绑定变量是**必填**的：缺失或为空时 `docker compose config` 会以非零退出并给出明确错误，
   不会退化成监听全部宿主接口。首次配置后先渲染一次确认：

   ```powershell
   docker compose -p weflow-test --env-file central/proxy.env `
     -f docker-compose.central.yml -f docker-compose.central.tls.yml config > $null
   ```

3. **只启动 Caddy**，不触碰已经在运行的 Central 与 PostgreSQL：

   ```powershell
   docker compose -p weflow-test --env-file central/proxy.env `
     -f docker-compose.central.yml -f docker-compose.central.tls.yml `
     up -d --no-deps --no-build --pull never caddy
   ```

   `--no-deps` 保证不连带启动或重启 `central` / `postgres`；`--no-build` 与 `--pull never`
   保证不构建、不联网拉取。**不要对全部服务执行 `up`**，也不要重建或重启 Central / PostgreSQL。

   查看状态与日志使用同一前缀：

   ```powershell
   docker compose -p weflow-test --env-file central/proxy.env `
     -f docker-compose.central.yml -f docker-compose.central.tls.yml ps
   docker compose -p weflow-test --env-file central/proxy.env `
     -f docker-compose.central.yml -f docker-compose.central.tls.yml logs --tail 100 caddy
   ```

   预期只有宿主 `127.0.0.1:8787` 的 Central 诊断映射和 Caddy 的 HTTPS 443；不开放 HTTP 80、
   PostgreSQL 5432，也不把 8787 绑定到 LAN 地址。

4. Caddy 首次启动后只取出公开根证书 `/data/caddy/pki/authorities/local/root.crt`，安装到测试客户机的
   受信任根证书存储，并在客户机 hosts 中临时加入 `192.168.1.57 weflow-central.test`。根私钥留在
   Caddy 数据卷内，禁止导出、打包或交给客户端。客户端使用正常 TLS 校验，禁止 `--insecure`。

5. 用 `https://weflow-central.test/health` 与 `/ready` 验证，不以"容器启动"代替端点验证。Docker
   Desktop 若把 LAN peer NAT 成 Docker 网关，`remote_ip` 会安全地全部拒绝；不要未经确认就把
   `client_ip` 或任意 `X-Forwarded-For` 当作可信来源，应先完成 Windows 真机网络路径复验。

## 回退

只停止并移除 Caddy 服务，不删除 PostgreSQL 卷或 Central `.env` / secret：

```powershell
docker compose -p weflow-test --env-file central/proxy.env `
  -f docker-compose.central.yml -f docker-compose.central.tls.yml `
  stop caddy
docker compose -p weflow-test --env-file central/proxy.env `
  -f docker-compose.central.yml -f docker-compose.central.tls.yml `
  rm -f caddy
```

**不要执行 `down -v`**：它会删除包括 `weflow-test_weflow-postgres` 在内的命名卷。

## 边界

本层仅用于当前临时内网测试。Windows 导入镜像、安装根证书、hosts、DHCP 保留、内部 DNS、时间同步、
Private 防火墙基线和 LAN 客户端真机复验均必须单独记录；未完成前不能称为正式上线。
