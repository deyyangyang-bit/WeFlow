/**
 * 角色视角（P0 占位）
 * 概念稿：只画「看得见 / 看不见」与依赖标记；故意不做角色切换开关。
 * 2026-09-19 起已从侧栏导航撤下（入口并入设置「我是谁」），路由保留可地址直达，正文结构留给后续波次。
 */
import './RoleViewPage.scss'

export default function RoleViewPage() {
  return (
    <div className="role-view-page">
      <header className="role-view-page__head">
        <div className="eyebrow">系统 · 角色视角</div>
        <h1 className="role-view-page__title">角色视角</h1>
        <p className="role-view-page__sub">
          这一屏用来对照销售 / 主管 / 分配员各自「看得见什么、看不见什么」。
          概念稿明确：不提供本机角色开关——角色是装机形态，不是可拨的权限玩具。
        </p>
      </header>

      <div className="role-view-page__grid" role="list">
        {[
          {
            role: '销售',
            see: ['自己的今日行动与客户', '自己的商机 / 合同 / 跟单', '聊天与 Hermes 助手'],
            hide: ['他人客户与分配池全量', '全员漏斗与团队复盘', '分配策略与改派台'],
            dep: '已实现（本机过滤） / 待服务端（投递边界）'
          },
          {
            role: '主管',
            see: ['团队复盘与行动漏斗', '成员负荷与逾期', '重要提醒汇总'],
            hide: ['替销售直接改分配归属（除非授权）'],
            dep: '待服务端'
          },
          {
            role: '分配员',
            see: ['线索池与分配台', '回收 / 重投记录', '同步诊断'],
            hide: ['销售私聊正文（默认）'],
            dep: '待拍板 / 待服务端'
          }
        ].map((block) => (
          <section key={block.role} className="role-card" role="listitem">
            <h2 className="role-card__t">{block.role}</h2>
            <div className="role-card__col">
              <h3>看得见</h3>
              <ul>{block.see.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div className="role-card__col">
              <h3>看不见</h3>
              <ul>{block.hide.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <p className="role-card__dep"><span className="tag">依赖</span>{block.dep}</p>
          </section>
        ))}
      </div>
    </div>
  )
}
