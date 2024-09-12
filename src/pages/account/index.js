import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import Hashicon from 'xelis-explorer/src/components/hashicon'
import Table from 'xelis-explorer/src/components/table'
import Pagination from 'xelis-explorer/src/components/pagination'
import { useLang } from 'g45-react/hooks/useLang'
import { formatXelis, reduceText, formatSize } from 'xelis-explorer/src/utils'
import useQueryString from 'g45-react/hooks/useQueryString'
import Age from 'g45-react/components/age'
import { addrs, formatAddr } from 'xelis-explorer/src/utils/known_addrs'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import Icon from 'g45-react/components/fontawesome_icon'
import DotLoading from 'xelis-explorer/src/components/dotLoading'
import { Helmet } from 'react-helmet-async'

import style from './style'
import { useFetchView } from '../../hooks/useFetchView'

const defaultQuery = { tab: `executed-transactions` }

function Account() {
  const [query, setQuery] = useQueryString(defaultQuery)
  const { addr } = useParams()
  const { t } = useLang()

  const changeTab = useCallback((item) => {
    setQuery({ tab: item.key })
  }, [])

  const [pageState, _setPageState] = useState(() => {
    const page = parseInt(query.page) || 1
    const size = parseInt(query.size) || 10
    return { page, size }
  })

  const setPageState = useCallback((value) => {
    _setPageState(value)
    setQuery({ ...query, ...value })
  }, [query])

  const offset = (pageState.page - 1) * pageState.size

  const dropdownTabs = useMemo(() => {
    return [{
      key: `executed-transactions`,
      text: <><Icon name="list" />&nbsp;&nbsp;{t(`Executed Transactions`)}</>
    }, {
      key: `incoming-transfers`,
      text: <><Icon name="arrow-down" />&nbsp;&nbsp;{t(`Incoming Transfers`)}</>
    }, {
      key: `mined-blocks`,
      text: <><Icon name="cube" />&nbsp;&nbsp;{t(`Mined Blocks`)}</>
    }]
  }, [t])

  return <div>
    <Helmet>
      <title>{t(`Account ${addr}`)}</title>
    </Helmet>
    <Profile />
    <div className={style.tabDropdown}>
      <Dropdown items={dropdownTabs} onChange={changeTab}
        value={query.tab} />
    </div>
    {query.tab === `incoming-transfers` && <IncomingTransfers pageState={pageState} setPageState={setPageState} offset={offset} />}
    {query.tab === `executed-transactions` && <ExecutedTransactions pageState={pageState} setPageState={setPageState} offset={offset} />}
    {query.tab === `mined-blocks` && <MinedBlocks pageState={pageState} setPageState={setPageState} offset={offset} />}
  </div>
}

function Profile(props) {
  const { addr } = useParams()
  const { t } = useLang()

  const account = useFetchView({
    view: `get_accounts()`,
    params: { count: true, limit: 20, where: [`addr::eq::${addr}`], }
  })

  const { rows, err, loading } = account

  const entity = addrs[addr]
  const data = rows[0]

  return <>
    {entity && <div className={style.profile.knownAccount}>
      <Icon name="tag" />
      <div>
        {t(`This is a known address owned by ${entity.name}.`)}<br />
        {entity.link && <>{t(`You can visit the website at `)}<a href={entity.link} target="_blank">{entity.link}</a>.</>}
      </div>
    </div>}
    {(!loading && !data) && <div className={style.error}>This account does not exists.</div>}
    <div className={style.profile.container}>
      <Hashicon value={addr} />
      <div className={style.profile.stats}>
        <div className={style.profile.addr}>
          {addr}
        </div>
        {data && <>
          <div>
            <a href={`${EXPLORER_LINK}/accounts/${addr}`} target="_blank">
              {t(`Explorer link`)}
            </a>
          </div>
          <div className={style.profile.statsItems}>
            <StatsItem title={t(`Last Activity`)} value={data.last_activity ? new Date(data.last_activity).toLocaleString() : `--`} />
            <StatsItem title={t(`Txs`)} value={data.total_txs.toLocaleString()} />
            <StatsItem title={t(`Transfers (In / Out)`)} value={`${(data.in_transfers || 0).toLocaleString()} / ${(data.out_transfers || 0).toLocaleString()}`} />
            <StatsItem title={t(`Mined Blocks`)} value={data.mined_blocks.toLocaleString()} />
            <StatsItem title={t(`Rewards`)} value={formatXelis(data.rewards)} />
          </div>
        </>}
        {loading && <DotLoading />}
      </div>
    </div>
  </>
}

function StatsItem(props) {
  const { title, value } = props
  return <div className={style.profile.item.container}>
    <div className={style.profile.item.title}>{title}</div>
    <div className={style.profile.item.value}>{value}</div>
  </div>
}

function IncomingTransfers(props) {
  const { pageState, setPageState, offset } = props
  const { addr } = useParams()
  const { t } = useLang()

  const transfers = useFetchView({
    view: `get_transfers()`,
    params: { count: true, offset, limit: pageState.size, order: [`timestamp::desc`], where: [`to::eq::${addr}`] }
  })

  const { rows, loading, count, err } = transfers

  return <div>
    <Table
      headers={[t(`Timestamp`), t(`Height`), t(`Topoheight`), t(`Tx Hash`), t(`Asset`), t(`From`), t(`Extra Data`), t(`Age`)]}
      list={rows} loading={loading} err={err} emptyText={t('No transfers')} colSpan={8}
      onItem={(item) => {
        return <React.Fragment key={`${item.index}-${item.tx_hash}`}>
          <tr>
            <td>{new Date(item.timestamp).toLocaleString()}</td>
            <td>
              <a href={`${EXPLORER_LINK}/height/${item.height}`} target="_blank">
                {item.height.toLocaleString()}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/blocks/${item.topoheight}`} target="_blank">
                {item.topoheight.toLocaleString()}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/txs/${item.tx_hash}`} target="_blank">
                {reduceText(item.tx_hash, 7, 7)}
              </a>
            </td>
            <td>
              {reduceText(item.asset)}
            </td>
            <td>
              <Link to={`/accounts/${item.source}`}>
                {formatAddr(item.source)}
              </Link>
            </td>
            <td>
              {reduceText(item.extra_data, 0, 20)}
            </td>
            <td><Age timestamp={item.timestamp} /></td>
          </tr>
        </React.Fragment>
      }}
    />
    <Pagination state={pageState} setState={setPageState} count={count}
      formatCount={(count) => t('{} transfers', [count.toLocaleString()])}
    />
  </div>
}

function MinedBlocks(props) {
  const { pageState, setPageState, offset } = props
  const { addr } = useParams()
  const { t } = useLang()


  const minedBlocks = useFetchView({
    view: `blocks`,
    params: { count: true, offset, limit: pageState.size, order: [`timestamp::desc`], where: [`miner::eq::${addr}`] }
  })

  const { rows, loading, count, err } = minedBlocks

  return <div>
    <Table
      headers={[t(`Timestamp`), t(`Hash`), t(`Height`), t(`Topoheight`), t(`Block Type`), t(`Reward`), t(`Txs`), t(`Size`), t(`Age`)]}
      list={rows} loading={loading} err={err} emptyText={t('No blocks')} colSpan={9}
      onItem={(item) => {
        return <React.Fragment key={item.hash}>
          <tr>
            <td>{new Date(item.timestamp).toLocaleString()}</td>
            <td>
              <a href={`${EXPLORER_LINK}/blocks/${item.hash}`} target="_blank">
                {reduceText(item.hash, 7, 7)}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/height/${item.height}`} target="_blank">
                {item.height.toLocaleString()}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/blocks/${item.topoheight}`} target="_blank">
                {item.topoheight.toLocaleString()}
              </a>
            </td>
            <td>{item.block_type}</td>
            <td>{formatXelis(item.reward)}</td>
            <td>{item.tx_count.toLocaleString()}</td>
            <td>{formatSize(item.total_size_in_bytes)}</td>
            <td><Age timestamp={item.timestamp} /></td>
          </tr>
        </React.Fragment>
      }}
    />
    <Pagination state={pageState} setState={setPageState} count={count}
      formatCount={(count) => t('{} blocks', [count.toLocaleString()])}
    />
  </div>
}

function ExecutedTransactions(props) {
  const { pageState, setPageState, offset } = props
  const { addr } = useParams()
  const { t } = useLang()

  const [showTransfers, setShowTransfers] = useState([])
  const toggleTransfer = useCallback((hash) => {
    if (showTransfers.indexOf(hash) === -1) {
      setShowTransfers([...showTransfers, hash])
    } else {
      setShowTransfers(showTransfers.filter(h => h !== hash))
    }
  }, [showTransfers])

  const transactions = useFetchView({
    view: `get_txs()`,
    params: { count: true, offset, limit: pageState.size, order: [`timestamp::desc`], where: [`source::eq::${addr}`] }
  })

  const { rows, loading, count, err } = transactions

  return <div>
    <Table
      headers={[t(`Timestamp`), t(`Hash`), t(`Height`), t(`Topoheight`), t(`Fee`), t(`Transfers`), t(`Age`)]}
      list={rows} loading={loading} err={err} emptyText={t('No transactions')} colSpan={7}
      onItem={(item) => {
        const visibleTransfers = showTransfers.indexOf(item.hash) !== -1

        return <React.Fragment key={item.hash}>
          <tr>
            <td>{new Date(item.timestamp).toLocaleString()}</td>
            <td>
              <a href={`${EXPLORER_LINK}/txs/${item.hash}`} target="_blank">
                {reduceText(item.hash, 7, 7)}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/height/${item.height}`} target="_blank">
                {item.height.toLocaleString()}
              </a>
            </td>
            <td>
              <a href={`${EXPLORER_LINK}/blocks/${item.topoheight}`} target="_blank">
                {item.topoheight.toLocaleString()}
              </a>
            </td>
            <td>{formatXelis(item.fee)}</td>
            <td>
              <button className={style.transfers.button} onClick={() => toggleTransfer(item.hash)}>
                {item.total_transfers.toLocaleString()}
                <Icon name={visibleTransfers ? `arrow-up` : `arrow-down`} />
              </button>
            </td>
            <td><Age timestamp={item.timestamp} /></td>
          </tr>
          <TxTransfersRows hash={item.hash} visible={visibleTransfers} />
        </React.Fragment>
      }}
    />
    <Pagination state={pageState} setState={setPageState} count={count}
      formatCount={(count) => t('{} transactions', [count.toLocaleString()])}
    />
  </div>
}

function TxTransfersRows(props) {
  const { hash, visible } = props

  const [loaded, setLoaded] = useState(false)

  const transfers = useFetchView({
    view: `transaction_transfers`,
    params: { where: [`tx_hash::eq::${hash}`] },
    fetchOnLoad: false
  })

  useEffect(() => {
    if (visible && !loaded) {
      transfers.fetch()
      setLoaded(true)
    }
  }, [visible, loaded])

  const { rows, loading } = transfers

  return <tr className={style.transfers.rows} data-visible={visible}>
    <td colSpan={7} >
      <div className={style.transfers.container}>
        {loading && <DotLoading />}
        {rows.map((item) => {
          return <div key={item.index} className={style.transfers.item}>
            <div>{item.index}</div>
            <div>
              {reduceText(item.asset)}
            </div>
            <div>
              <Link to={`/accounts/${item.to}`}>
                {formatAddr(item.to)}
              </Link>
            </div>
            {item.extra_data && <div>
              {reduceText(item.extra_data, 0, 20)}
            </div>}
          </div>
        })}
      </div>
    </td>
  </tr>
}

export default Account
