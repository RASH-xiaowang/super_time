/**
 * 聊天侧共用的客户画像抽屉。
 *
 * 单聊「聊天信息」从这里打开同一个内容组件。群成员和企业微信联系人不做画像。
 */
import { Drawer } from '../ui/kit.tsx'
import { useCustomer360 } from './use-customer-360.ts'
import { CustomerPortraitView } from './CustomerPortraitView.tsx'
import { customerDisplayName, type CustomerIdentity, type CustomerProfileContext } from './customer-profile.ts'
import { withEnterprise } from './enterprise-identity.ts'

export interface CustomerPortraitDialogProps {
  open: boolean
  identity: CustomerIdentity | null
  onClose: () => void
  context?: CustomerProfileContext
}

/** 打开当前好友的完整画像与标签。 */
export function CustomerPortraitDialog({
  open, identity, onClose, context = {},
}: CustomerPortraitDialogProps): React.JSX.Element {
  const { snapshot, loading, error, reload } = useCustomer360(open ? identity?.username ?? null : null)
  const title = identity
    ? `${withEnterprise(customerDisplayName(identity), identity.enterpriseName)} · 客户画像与标签`
    : '客户画像与标签'
  return (
    <Drawer open={open && identity !== null} onClose={onClose} title={title} width={540}>
      {identity && (
        <CustomerPortraitView
          identity={identity}
          snapshot={snapshot}
          loading={loading}
          error={error}
          onRetry={reload}
          context={context}
          compact
        />
      )}
    </Drawer>
  )
}
