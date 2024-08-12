import React, { useCallback, useMemo, useState } from 'react'
import { useLang } from 'g45-react/hooks/useLang'
import { formatXelis } from 'xelis-explorer/src/utils'
import { formatAddr } from 'xelis-explorer/src/utils/known_addrs'
import Table from 'xelis-explorer/src/components/table'
import Hashicon from 'xelis-explorer/src/components/hashicon'
import memPoolStyle from 'xelis-explorer/src/pages/memPool/style'
import { Link, useNavigate } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import useQueryString from 'g45-react/hooks/useQueryString'
import Pagination from 'xelis-explorer/src/components/pagination'

import { useFetchView } from '../../hooks/useFetchView'
import style from './style'

function Accounts() {
  const { t } = useLang()
  const [query, setQuery] = useQueryString({})

  const [sort, _setSort] = useState(() => {
    const key = query.sort || `total_txs`
    const direction = query.direction || `desc`
    return { key, direction }
  })

  const setSort = useCallback((value) => {
    _setSort(value)
    setQuery({ ...query, sort: value.key, direction: value.direction })
  }, [query])

  const [pageState, _setPageState] = useState(() => {
    const page = parseInt(query.page) || 1
    const size = parseInt(query.size) || 20
    return { page, size, sort }
  })

  const setPageState = useCallback((value) => {
    _setPageState(value)
    setQuery({ ...query, ...value })
  }, [query])

  const offset = (pageState.page - 1) * pageState.size
  const order = `${sort.key}::${sort.direction}`

  const accounts = useFetchView({
    view: `get_accounts()`,
    params: { count: true, limit: pageState.size, offset, order: [order], }
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
        headers={[
          { key: `addr`, text: t(`Address`), sort: false },
          { key: `last_activity`, text: t(`Last Activity`), sort: true },
          { key: `total_txs`, text: t(`Txs`), sort: true },
          { key: `total_fees`, text: t(`Fees`), sort: true },
          { key: `in_transfers`, text: t(`Transfers In`), sort: true },
          { key: `out_transfers`, text: t(`Transfers Out`), sort: true },
          { key: `mined_blocks`, text: t(`Mined Blocks`), sort: true },
          { key: `rewards`, text: t(`Rewards`), sort: true },
        ]}
        list={rows} loading={loading} err={err} emptyText={t('No accounts')} colSpan={8}
        sortState={sort}
        onSort={(header) => {
          let direction = `desc`
          if (sort.key === header.key) {
            direction = sort.direction === `desc` ? `asc` : `desc`
          }

          setSort({ key: header.key, direction })
        }}
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
                {item.in_transfers.toLocaleString()}
              </td>
              <td>
                {item.out_transfers.toLocaleString()}
              </td>
              <td>{item.mined_blocks.toLocaleString()}</td>
              <td>{formatXelis(item.rewards)}</td>
            </tr>
          </React.Fragment>
        }}
      />
      <Pagination state={pageState} setState={setPageState} count={count}
        formatCount={(count) => t('{} accounts', [count.toLocaleString()])}
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
