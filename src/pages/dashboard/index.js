import { css } from 'goober'
import Icon from 'g45-react/components/fontawesome_icon'
import theme from 'xelis-explorer/src/style/theme'
import { useLang } from 'g45-react/hooks/useLang'
import prettyMs from 'pretty-ms'
import { formatHashRate, formatSize, formatXelis, reduceText } from 'xelis-explorer/src/utils'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
dayjs.extend(utc)

import Box, { BoxChart, BoxTable } from './box'
import supabase from '../../hooks/useSupabase'
import { Helmet } from 'react-helmet-async'

const style = {
  title: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 2em 0 3em 0;
    gap: 1em;

    > :nth-child(1) {
      width: 3em;
      height: 3em;
      display: block;
      background-size: contain;
      background-repeat: no-repeat;
      background-image: ${theme.apply({ xelis: `url('public/img/white_background_black_logo.svg')`, light: `url('public/img/black_background_white_logo.svg')`, dark: `url('public/img/white_background_black_logo.svg')`, })};
    }

    > :nth-child(2) {
      font-size: 2.5em;
      font-weight: bold;
    }

    > :nth-child(3) {
      max-width: 27em;
      text-align: center;
      opacity: .9;
    }
  `,
  autoUpdate: css`
    background: rgb(0 0 0 / 30%);
    padding: 0.5em 1em;
    border-radius: 0.5em;
    opacity: .8;
    margin: 0 auto;
    width: 12em;
    text-align: center;
    color: var(--text-color);
  `,
  container: css`
    display: flex;
    gap: 2em;
    flex-direction: column;

    > div {
      display: flex;
      gap: 1.5em;
      flex-direction: column;

      > :nth-child(1) {
        font-weight: bold;
        font-size: 1.8em;
        display: flex;
        gap: .5em;
        align-items: center;
      }

      > :nth-child(2) {
        display: flex;
        gap: 1em;
        overflow-x: scroll;
        padding-bottom: 1em;
      }

      > :nth-child(3) {
        display: flex;
        flex-wrap: wrap;
        gap: .5em;

        > a {
          white-space: nowrap;
          padding: .5em;
          background: rgb(0 0 0 / 40%);
          text-decoration: none;
        }
      }
    }
  `
}

function randomData({ min = 5, max = 50 } = {}) {
  const data = []
  const end = Math.floor(Math.random() * (max - min) + min)
  for (let i = 0; i < end; i++) {
    data.push({
      x: `${i}`,
      y: Math.floor(Math.random() * (1000 - 250 + 1) + 250),
    })
  }
  return data
}

function randomStepData({ step = 1, inverse = false } = {}) {
  const data = []
  let start = 0
  let end = 25

  for (let i = start; i < end; i += step) {
    let prev = data[i - 1]
    if (prev) prev = prev.y
    else prev = (inverse ? 2000 : 0)

    let value = prev + Math.random() * 100
    if (inverse) value = prev - Math.random() * 100

    data.push({
      x: `${i}`,
      y: value,
    })
  }

  return data
}

function formatNumber(v) {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function percentageDiff(value1, value2) {
  let absDiff = Math.abs(value1 - value2)
  let avg = (value1 + value2) / 2
  if (avg === 0) return ``

  let percentageDiff = formatNumber((absDiff / avg) * 100)
  if (percentageDiff == 0) return ``

  if (value1 > value2) {
    return `+${percentageDiff}%`
  }

  return `-${percentageDiff}%`
}

function useFetchSupabase(props) {
  const { getQuery, offset = 0, limit = 100, setLoadingOnReload = false } = props

  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState()
  const [data, setData] = useState([])
  const [count, setCount] = useState(0)

  const load = useCallback(async (reload) => {
    if (!reload || (reload && setLoadingOnReload)) setLoading(true)

    const resErr = (err) => {
      setLoading(false)
      setErr(err)
    }

    const query = getQuery()
    const { error, data, count } = await query.range(offset, limit - 1)
    if (error) return resErr(err)

    setCount(count)
    setData(data)
    setLoading(false)
    setErr(null)
  }, [offset, limit, setLoadingOnReload])

  useEffect(() => {
    load()
  }, [load])

  const reload = useCallback(() => {
    load(true)
  }, [load])

  return { loading, err, data, count, reload }
}

function BoxMarketCap(props) {
  const { marketHistoryDaily, blocksDaily } = props

  const { t } = useLang()

  const dataChart = useMemo(() => {
    const data = marketHistoryDaily.data.map((item, index) => {
      const { time, last_price } = item
      const { supply = 0 } = blocksDaily.data[index] || {}
      const shiftSupply = supply / Math.pow(10, 5)
      return { time, market_cap: last_price * shiftSupply }
    })

    const first = data[0]
    const second = data[1]

    let value = `--`, extra = ``
    if (first) {
      value = formatNumber(first.market_cap)
      if (second) extra = percentageDiff(first.market_cap, second.market_cap)
    }

    data.reverse()
    return { value, extra, data }
  }, [marketHistoryDaily, blocksDaily])

  const xFormat = useCallback((v) => {
    return new Date(v).toLocaleString()
  }, [])

  const yFormat = useCallback((v) => {
    return `${formatNumber(v)}`
  }, [])

  const { value, extra, data } = dataChart
  const noData = data.length === 0
  const loading = marketHistoryDaily.loading || blocksDaily.loading

  return <Box name={t(`Market cap.`)} value={value} extra={extra} loading={loading} noData={noData}>
    <BoxChart data={data} areaType="monotone" xDataKey="time" yDataKey="market_cap" xFormat={xFormat} yName={t(`Market Cap.`)} yFormat={yFormat} />
  </Box>
}

function BoxExchanges(props) {
  const { marketHistoryExchangeDaily, stats } = props

  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `name`, title: t(`Name`) },
      { key: `volume`, title: t(`Volume`) },
      { key: `price`, title: t(`Price`) },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`

    const statsData = stats.data[0] || {}
    const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')

    if (stats.data[0]) {
      value = stats.data[0].exchange_count
    }

    const data = []
    for (let i = 0; i < marketHistoryExchangeDaily.data.length; i++) {
      const item = marketHistoryExchangeDaily.data[i]
      const date = item.time.split('T')[0]

      if (date === lastBlockDate) {
        data.push({ name: item.exchange, volume: formatNumber(item.sum_quantity), price: formatNumber(item.last_price) })
      }
    }

    return { value, data }
  }, [marketHistoryExchangeDaily])


  const { value, data } = boxData
  const loading = marketHistoryExchangeDaily.loading || stats.loading

  return <Box name={t(`Exchanges (1d)`)} value={value} loading={loading}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxBlocks(props) {
  const { recentBlocks } = props

  const { t } = useLang()

  const totalBlocks = useMemo(() => {
    if (!recentBlocks.data[0]) return `--`
    return (recentBlocks.data[0].topoheight + 1).toLocaleString()
  }, [recentBlocks])

  const headers = useMemo(() => {
    return [
      { key: `topo`, title: `Topo` },
      { key: `txs`, title: `Txs` },
      { key: `fees`, title: `Fees` },
    ]
  }, [])

  const data = useMemo(() => {
    return recentBlocks.data.map((item) => {
      const { topoheight, tx_count, total_fees } = item
      return { topo: topoheight.toLocaleString(), txs: tx_count, fees: formatXelis(total_fees) }
    })
  }, [recentBlocks])

  const loading = recentBlocks.loading

  return <Box name={t(`Blocks`)} value={totalBlocks} loading={loading} link={`/database?data_source=blocks_by_range&key=avg_difficulty&range=1&view=table`}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxTimeChart(props) {
  const { name, yName, yDataKey, yFormat, dataResponse, info, areaType, link, bottomInfo, yDomain } = props

  const boxData = useMemo(() => {
    const first = dataResponse.data[0]
    const second = dataResponse.data[1]

    let value = `--`, extra = ``
    if (first) {
      value = first[yDataKey]
      if (typeof yFormat === `function`) value = yFormat(first[yDataKey])
      if (second) extra = percentageDiff(first[yDataKey], second[yDataKey])
    }

    const data = Object.assign([], dataResponse.data)
    data.reverse()
    return { value, extra, data }
  }, [dataResponse, yDataKey])

  const xFormat = useCallback((v) => {
    return new Date(v).toLocaleString()
  }, [])

  const { value, extra, data } = boxData
  const noData = data.length === 0

  return <Box name={name} value={value} extra={extra} info={info} loading={dataResponse.loading} link={link} bottomInfo={bottomInfo} noData={noData}>
    <BoxChart data={data} areaType={areaType} xDataKey="time" yDataKey={yDataKey} xFormat={xFormat} yName={yName} yFormat={yFormat} yDomain={yDomain} />
  </Box>
}

function BoxDevFee(props) {
  const { stats } = props
  const { t } = useLang()

  const devFeeThresholds = useMemo(() => {
    return [
      { fee_percentage: 15, height: 0 },
      { fee_percentage: 10, height: 1250000 },
      { fee_percentage: 5, height: 3000000 }]
  }, [])

  const headers = useMemo(() => {
    return [
      { key: `fee`, title: `Fee` },
      { key: `height`, title: `Height` },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra = ``

    const data = []
    let found = false
    for (let i = 0; i < devFeeThresholds.length; i++) {
      const item = devFeeThresholds[i]
      const nextItem = devFeeThresholds[i + 1]

      if (stats.data[0] && !found) {
        const currentHeight = stats.data[0].height
        value = `${item.fee_percentage}%`

        if (nextItem && currentHeight < nextItem.height) {
          const blocksLeft = (nextItem.height - currentHeight).toLocaleString()
          extra = t(`{} blocks left`, [blocksLeft])
          found = true
        }
      }

      data.push({ fee: `${item.fee_percentage}%`, height: `${item.height.toLocaleString()}` })
    }

    return { value, extra, data }
  }, [devFeeThresholds, stats, t])

  const { value, extra, data } = boxData

  return <Box name={t(`Dev Fee`)} value={value} extra={extra}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxTopMiners(props) {
  const { minersDaily, stats } = props
  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `addr`, title: t(`Addr`) },
      { key: `blocks`, title: t(`Blocks`) },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra

    const statsData = stats.data[0] || {}
    const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')

    const data = []
    for (let i = 0; i < minersDaily.data.length; i++) {
      const item = minersDaily.data[i]
      const date = item.time.split('T')[0]

      if (date === lastBlockDate) {
        data.push({ addr: reduceText(item.miner, 0, 7), blocks: formatNumber(item.total_blocks) })
      }
    }

    const first = data[0]
    if (first) {
      value = first.addr
      extra = first.blocks
    }

    return { value, extra, data }
  }, [minersDaily, stats])

  const { value, extra, data } = boxData
  const loading = minersDaily.loading || stats.loading

  return <Box name={t(`Top Miners (1d)`)} value={value} extra={extra} loading={loading}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxTopAccounts(props) {
  const { accountsWeekly, stats } = props

  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `addr`, title: t(`Addr`) },
      { key: `txs`, title: t(`Txs`) },
      { key: `fees`, title: t(`Fees`) }
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra = ``

    const statsData = stats.data[0] || {}
    const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')

    const data = []
    for (let i = 0; i < accountsWeekly.data.length; i++) {
      const item = accountsWeekly.data[i]
      const date = item.time.split('T')[0]

      if (date === lastBlockDate) {
        data.push({ addr: reduceText(item.miner, 0, 7), blocks: formatNumber(item.total_blocks) })
      }
    }

    const first = data[0]
    if (first) {
      value = first.addr
      extra = first.total_txs
    }

    return { value, extra, data }
  }, [accountsWeekly, stats])

  const { value, extra, data } = boxData
  const loading = accountsWeekly.loading

  return <Box name={t(`Top Accounts (1w)`)} value={value} extra={extra} loading={loading}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxBlockTypes(props) {
  const { } = props

  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `type`, title: t(`Type`) },
      { key: `count`, title: t(`Count`) },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra = ``

    return { value, extra, data: [] }
  }, [])

  const { value, extra, data } = boxData

  return <Box name={t(`Block Types (1d)`)} value={value} extra={extra} loading={false}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function AutoUpdate(props) {
  const { onUpdate, start = 60 * 1000 } = props

  const [duration, setDuration] = useState(start)

  useEffect(() => {
    let intervalId = setInterval(() => {
      setDuration((current) => {
        if (current <= 0) {
          if (typeof onUpdate === `function`) onUpdate()
          return start
        }

        return current - 1000
      })
    }, 1000)
    return () => clearInterval(intervalId)
  }, [onUpdate])

  return <div className={style.autoUpdate}>
    Auto Update in {prettyMs(duration)}
  </div>
}

function Home() {
  const { t } = useLang()

  const marketHistoryHourly = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_market_history`, { time_range: 'hour' }, { count: `exact` })
        .eq(`asset`, `USDT`)
        .order(`time`, { ascending: false })
    },
    limit: 24,
  })

  const marketHistoryDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_market_history`, { time_range: 'day' }, { count: `exact` })
        .eq(`asset`, `USDT`)
        .order(`time`, { ascending: false })
    },
    limit: 7,
  })

  const marketHistoryExchangeDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_market_history_exchange`, { time_range: 'day' }, { count: `exact` })
        .eq(`asset`, `USDT`)
        .order(`time`, { ascending: false })
        .order(`sum_quantity`, { ascending: false })
    },
    limit: 3,
  })

  const recentBlocks = useFetchSupabase({
    getQuery: () => {
      return supabase.from(`blocks`).select(`*`)
        .order(`topoheight`, { ascending: false })
    },
    limit: 20,
  })

  const blocksDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_blocks_time`, { time_range: 'day' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20,
  })

  const stats = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_stats`, null, { count: `exact` })
    },
    limit: 1,
  })

  const minersDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_miners_blocks_time`, { time_range: 'day' }, { count: `exact` })
        .order(`time`, { ascending: false })
        .order(`total_blocks`, { ascending: false })
    },
    limit: 20,
  })

  const minersCountDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_miners_count_time`, { time_range: 'day' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20
  })

  const accountsCountDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_accounts_count_time`, { time_range: 'day' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20
  })

  const accountsWeekly = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_accounts_txs_time`, { time_range: 'week' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20
  })

  const activeAccountsWeekly = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_accounts_active_time`, { time_range: 'week' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20
  })

  const txsDaily = useFetchSupabase({
    getQuery: () => {
      return supabase.rpc(`get_txs_time`, { time_range: 'day' }, { count: `exact` })
        .order(`time`, { ascending: false })
    },
    limit: 20
  })

  const reload = useCallback(() => {
    marketHistoryHourly.reload()
    marketHistoryExchangeDaily.reload()
    recentBlocks.reload()
    blocksDaily.reload()
  }, [marketHistoryHourly, marketHistoryExchangeDaily, recentBlocks, blocksDaily])

  // Transactions per minute
  const tpm = useMemo(() => {
    const data = blocksDaily.data[0] || {}
    if (!data.sum_tx_count) return 0
    return formatNumber(data.sum_tx_count / 3600)
  }, [blocksDaily])

  const description = useMemo(() => {
    return t('Find all your answers about the XELIS network. Click the expand icon of a component to delve deeper into that specific data stream.')
  }, [t])

  return <div>
    <Helmet>
      <title>Dashboard</title>
      <meta name="description" content={description} />
    </Helmet>
    <div className={style.title}>
      <div /> {/* This is the logo */}
      <h1>XELIS Statistics</h1>
      <div>{description}</div>
      <AutoUpdate onUpdate={reload} />
    </div>
    <div className={style.container}>
      <div>
        <div><Icon name="coins" />{t(`Market`)}</div>
        <div>
          <BoxTimeChart dataResponse={marketHistoryHourly} areaType="monotone" name={t(`Price (1h)`)} yDataKey="last_price" yFormat={(v) => formatNumber(v)} link={`/database?data_source=market_history&key=price_candle&range=hour&view=candle_chart`} />
          <BoxTimeChart dataResponse={marketHistoryHourly} areaType="step" name={t(`Volume (1h)`)} yDataKey="sum_quantity" yFormat={(v) => formatNumber(v)} link={`/database?data_source=market_history&key=sum_quantity&range=hour&view=area_chart`} />
          <BoxMarketCap marketHistoryDaily={marketHistoryDaily} blocksDaily={blocksDaily} />
          <BoxExchanges marketHistoryExchangeDaily={marketHistoryExchangeDaily} stats={stats} />
        </div>
      </div>
      <div>
        <div><Icon name="cube" />{t(`Blockchain`)}</div>
        <div>
          <BoxBlocks recentBlocks={recentBlocks} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="step" name={t(`Size`)} yDataKey="cumulative_block_size" yFormat={(v) => formatSize(v)} link={`/database?data_source=blocks_by_time&key=cumulative_block_size&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="natural" name={t(`Circulating Supply`)} yDataKey="cumulative_block_reward" yFormat={(v) => formatXelis(v)} bottomInfo={t(`Max Supply: {}`, [(18000000).toLocaleString()])} link={`/database?data_source=blocks_by_time&key=cumulative_block_reward&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="step" name={t(`Block Time`)} yDataKey="block_time" yFormat={(v) => prettyMs(v)} link={`/database?data_source=blocks_by_time&key=block_time&range=day&view=area_chart`} />
          <BoxDevFee stats={stats} />
          <BoxBlockTypes />
        </div>
      </div>
      <div>
        <div><Icon name="receipt" />{t(`Transactions`)}</div>
        <div>
          <BoxTimeChart dataResponse={blocksDaily} areaType="step" name={t(`Total`)} yDataKey="cumulative_tx_count" yFormat={(v) => v.toLocaleString()} link={`/database?data_source=blocks_by_time&key=cumulative_tx_count&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="monotone" name={t(`Txs (1d)`)} yDataKey="sum_tx_count" yFormat={(v) => v.toLocaleString()} bottomInfo={<>{tpm} TPM</>} link={`/database?data_source=blocks_by_time&key=sum_tx_count&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="step" name={t(`Total Fees`)} yDataKey="cumulative_total_fees" yFormat={(v) => formatXelis(v)} link={`/database?data_source=blocks_by_time&key=cumulative_total_fees&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="monotone" name={t(`Total Fees (1d)`)} yDataKey="sum_total_fees" yFormat={(v) => formatXelis(v)} link={`/database?data_source=blocks_by_time&key=sum_total_fees&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={txsDaily} areaType="monotone" name={t(`Transfers (1d)`)} yDataKey="transfer_count" yFormat={(v) => v.toLocaleString()} />
        </div>
      </div>
      <div>
        <div><Icon name="microchip" />{t(`Mining`)}</div>
        <div>
          <BoxTimeChart dataResponse={minersCountDaily} areaType="step" name={t(`Miners (1d)`)} yName={t(`Miners`)} yDataKey="miner_count" yFormat={(v) => `${v.toLocaleString()}`}
            info={t(`The network can have way more active miners. These are only the miners who were succesful in mining at least one block.`)} yDomain={[0, 'dataMax']} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="monotone" name={t(`Hash Rate (avg)`)} yName={t(`Hash Rate`)} yDataKey="avg_difficulty" yFormat={(v) => formatHashRate(v / 15)} link={`/database?data_source=blocks_by_time&key=avg_difficulty&range=day&view=area_chart`} />
          <BoxTimeChart dataResponse={blocksDaily} areaType="monotone" name={t(`Reward (avg)`)} yName={t(`Reward (avg)`)} yDataKey="avg_block_reward" yFormat={(v) => formatXelis(v)} link={`/database?data_source=blocks_by_time&key=avg_block_reward&range=day&view=area_chart`} />
          <BoxTopMiners minersDaily={minersDaily} stats={stats} />
        </div>
      </div>
      <div>
        <div><Icon name="users" />{t(`Accounts`)}</div>
        <div>
          <BoxTimeChart dataResponse={accountsCountDaily} areaType="monotstep" name={t(`Accounts`)} yName={t(`Accounts`)} yDataKey="cumulative_account_count" yFormat={(v) => `${v.toLocaleString()}`} />
          <BoxTopAccounts accountsWeekly={accountsWeekly} stats={stats} />
          <BoxTimeChart dataResponse={accountsCountDaily} areaType="monotstep" name={t(`Registered (1d)`)} yName={t(`Accounts`)} yDataKey="account_count" yFormat={(v) => `${v.toLocaleString()}`} yDomain={[0, 'dataMax']} />
          <BoxTimeChart dataResponse={activeAccountsWeekly} areaType="monotstep" name={t(`Active (1w)`)} yName={t(`Accounts`)} yDataKey="active_accounts" yFormat={(v) => `${v.toLocaleString()}`} info={t(`Send at least one transaction.`)} yDomain={[0, 'dataMax']} />
        </div>
      </div>
      <div>
        <div><Icon name="file-code" />{t(`Contracts`)}</div>
        <div>
          <Box name="Total" value="--" noData>
            <BoxChart />
          </Box>
          <Box name="Deployed (24h)" value="--" noData>
            <BoxChart />
          </Box>
          <Box name="Calls" value="--" noData>
            <BoxChart />
          </Box>
          <Box name="Calls (24h)" value="--" noData>
            <BoxChart />
          </Box>
        </div>
      </div>
    </div>
  </div>
}

export default Home