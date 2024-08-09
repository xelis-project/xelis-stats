import React, { useCallback, useMemo } from 'react'
import { useLang } from 'g45-react/hooks/useLang'
import { formatXelis } from 'xelis-explorer/src/utils'
import { formatAddr } from 'xelis-explorer/src/utils/known_addrs'
import Table from 'xelis-explorer/src/components/table'
import Hashicon from 'xelis-explorer/src/components/hashicon'
import memPoolStyle from 'xelis-explorer/src/pages/memPool/style'
import { Link, useNavigate } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'

import { useFetchView } from '../../hooks/useFetchView'
import style from './style'

function Accounts() {
  const { t } = useLang()

  const accounts = useFetchView({
    view: `get_accounts()`,
    params: { count: true, limit: 20, order: [`total_txs::desc`], }
  })

  const { loading, err, count, rows } = accounts

  const description = useMemo(() => {
    return t('List popular accounts or search a specific one.')
  }, [t])

  return <div className={style.container}>
    <SearchAccount />
    <div>
      <div className={style.title}>{t(`Popular accounts`)}</div>
      <Helmet>
        <title>{t(`Accounts`)}</title>
        <meta name="description" content={description} />
      </Helmet>
      <Table
        headers={[t(`Address`), t(`Last Activity`), t(`Txs`), t(`Fees`), t(`Transfers (In / Out)`), t(`Mined Blocks`), t(`Rewards`)]}
        list={rows} loading={loading} err={err} emptyText={t('No accounts')} colSpan={7}
        onItem={(item) => {
          return <React.Fragment key={item.addr}>
            <tr>
              <td>
                <div className={style.accountAddr}>
                  <Hashicon size={25} value={item.addr} />
                  <Link to={`/accounts/${item.addr}`}>
                    {formatAddr(item.addr)}
                  </Link>
                </div>
              </td>
              <td>{new Date(item.last_activity).toLocaleString()}</td>
              <td>{item.total_txs.toLocaleString()}</td>
              <td>{formatXelis(item.total_fees)}</td>
              <td>
                {item.in_transfers.toLocaleString()} | {item.out_transfers.toLocaleString()}
              </td>
              <td>{item.mined_blocks.toLocaleString()}</td>
              <td>{formatXelis(item.rewards)}</td>
            </tr>
          </React.Fragment>
        }}
      />
    </div>
  </div>
}

function SearchAccount() {
  const { t } = useLang()
  const navigate = useNavigate()

  const onSubmit = useCallback((e) => {
    const formData = new FormData(e.target)
    const addr = formData.get(`addr`)

    navigate(`/accounts/${addr}`)
  }, [])

  return <form onSubmit={onSubmit}>
    <input className={memPoolStyle.searchInput} type="text" name="addr"
      placeholder={t('Type the account address and press enter.')} />
  </form>
}

export default Accounts
