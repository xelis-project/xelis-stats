import { css } from 'goober'
import Icon from 'g45-react/components/fontawesome_icon'
import theme from 'xelis-explorer/src/style/theme'
import { useLang } from 'g45-react/hooks/useLang'
import prettyMs from 'pretty-ms'
import { formatHashRate, formatSize, formatXelis, reduceText } from 'xelis-explorer/src/utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Helmet } from 'react-helmet-async'
import DotLoading from 'xelis-explorer/src/components/dotLoading'
import { Link } from 'react-router-dom'
import { Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
dayjs.extend(utc)

import Box, { BoxAreaChart, BoxTable, useChartStyle } from './box'
import { useFetchView } from '../../hooks/useFetchView'
import { style as boxStyle } from './box'
import supplyEmissionData from '../../data/supply_emission.json'

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
  topStats: css`
    padding: 1em;
    margin-bottom: 2em;
    background-color: ${theme.apply({ xelis: ` rgb(0 0 0 / 50%)`, dark: ` rgb(0 0 0 / 50%)`, light: ` rgb(255 255 255 / 50%)` })};
    border-radius: 0.5em;
    color: var(--text-color);
    display: flex;
    gap: 2.5em;
    overflow: auto;
    justify-content: space-between;

    > div {
      display: flex;
      gap: .3em;
      flex-direction: column;

      > :nth-child(1) {
        font-size: .9em;
        opacity: .6;
      }

      > :nth-child(2) {
        font-size: 1.5em;
        white-space: nowrap;
      }
    }

    .loading {
      opacity: .6;
    }
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

function BoxMarketCap(props) {
  const { marketHistoryDaily, blocksDaily } = props

  const { t } = useLang()

  const dataChart = useMemo(() => {
    const data = marketHistoryDaily.rows.map((item, index) => {
      const { time, price } = item
      const { supply = 0 } = blocksDaily.rows[index] || {}
      const shiftSupply = supply / Math.pow(10, 8)
      return { time, market_cap: price * shiftSupply }
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
    <BoxAreaChart data={data} areaType="monotone" xDataKey="time" yDataKey="market_cap" xFormat={xFormat} yName={t(`Market Cap.`)} yFormat={yFormat} />
  </Box>
}

function BoxExchanges(props) {
  const { marketHistoryExchangeDaily } = props

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

    //const statsData = stats.rows[0] || {}
    //const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')

    value = marketHistoryExchangeDaily.count

    const data = []
    for (let i = 0; i < marketHistoryExchangeDaily.rows.length; i++) {
      const item = marketHistoryExchangeDaily.rows[i]
      //const date = item.time.split('T')[0]

      //if (date === lastBlockDate) {
      data.push({ name: item.exchange, volume: formatNumber(item.volume), price: formatNumber(item.price) })
      //}
    }

    return { value, data }
  }, [marketHistoryExchangeDaily])


  const { value, data } = boxData
  const loading = marketHistoryExchangeDaily.loading

  return <Box name={t(`Exchanges (last 24h)`)} value={value} loading={loading}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxBlocks(props) {
  const { recentBlocks } = props

  const { t } = useLang()

  const totalBlocks = useMemo(() => {
    if (!recentBlocks.count) return `--`
    return recentBlocks.count.toLocaleString()
  }, [recentBlocks])

  const headers = useMemo(() => {
    return [
      {
        key: `topo`, title: `Topo`, render: (v) => {
          if (v) {
            return <a href={`${EXPLORER_LINK}/blocks/${v}`} target="_blank">
              {v.toLocaleString()}
            </a>
          }
          return `--`
        }
      },
      { key: `txs`, title: `Txs` },
      { key: `fees`, title: `Fees` },
    ]
  }, [])

  const data = useMemo(() => {
    return recentBlocks.rows.map((item) => {
      const { topoheight, tx_count, total_fees } = item
      return { topo: topoheight, txs: tx_count, fees: formatXelis(total_fees, { withSuffix: false }) }
    })
  }, [recentBlocks])

  const loading = recentBlocks.loading

  return <Box name={t(`Blocks`)} value={totalBlocks} loading={loading} link={`/views/blocks_by_range?period=1&view=table`}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxTimeChart(props) {
  const { name, yName, yDataKey, yFormat, data, info, areaType, link, bottomInfo, yDomain } = props

  const boxData = useMemo(() => {
    const first = (data.rows || [])[0]
    const second = (data.rows || [])[1]

    let value = `--`, extra = ``
    if (first) {
      value = first[yDataKey]
      if (typeof yFormat === `function`) value = yFormat(first[yDataKey])
      if (second) extra = percentageDiff(first[yDataKey], second[yDataKey])
    }

    const rows = Object.assign([], data.rows)
    rows.reverse()

    return { value, extra, rows }
  }, [data, yDataKey])

  const xFormat = useCallback((v) => {
    return new Date(v).toLocaleString()
  }, [])

  const { value, extra, rows } = boxData
  const noData = rows.length === 0

  return <Box name={name} value={value} extra={extra} info={info} loading={data.loading} link={link} bottomInfo={bottomInfo} noData={noData}>
    <BoxAreaChart data={rows} areaType={areaType} xDataKey="time" yDataKey={yDataKey} xFormat={xFormat} yName={yName} yFormat={yFormat} yDomain={yDomain} />
  </Box>
}

function BoxDevFee(props) {
  const { stats } = props
  const { t } = useLang()

  const devFeeThresholds = useMemo(() => {
    return [
      { fee_percentage: 10, height: 0 },
      { fee_percentage: 5, height: 3_250_000 }]
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

      if (stats.rows[0] && !found) {
        const currentHeight = stats.rows[0].height
        value = `${item.fee_percentage}%`

        if (nextItem && currentHeight < nextItem.height) {
          const blocksLeft = (nextItem.height - currentHeight).toLocaleString()
          extra = t(`{} blocks left`, [blocksLeft])
          found = true
        }
      }

      let height = `${item.height.toLocaleString()}`
      if (nextItem) {
        height += ` - ${(nextItem.height - 1).toLocaleString()}`
      } else {
        height += ` - ?`
      }

      data.push({
        fee: `${item.fee_percentage}%`,
        height: height
      })
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
      {
        key: `addr`, title: t(`Addr`),
        render: (v) => {
          if (v) {
            return <Link to={`/views/get_miners_blocks_time?period=86400&view=table&order=time::desc&where=miner::eq::${v}`}>
              {reduceText(v, 0, 7)}
            </Link>
          }

          return `--`
        }
      },
      { key: `blocks`, title: t(`Blocks`) },
      { key: `reward`, title: t(`Reward`) },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra

    const statsData = stats.rows[0] || {}
    //const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')

    const data = []
    for (let i = 0; i < minersDaily.rows.length; i++) {
      const item = minersDaily.rows[i]
      const date = item.time.split('T')[0]

      //if (date === lastBlockDate) {
      const reward = reduceText(formatXelis(item.total_reward, { withSuffix: false }), 7, 0)
      data.push({ addr: item.miner, blocks: formatNumber(item.total_blocks), reward })
      //}
    }

    const first = data[0]
    if (first) {
      value = reduceText(first.addr, 0, 7)
      extra = first.blocks
    }

    return { value, extra, data }
  }, [minersDaily, stats])

  const { value, extra, data } = boxData
  const loading = minersDaily.loading || stats.loading

  return <Box name={t(`Top Miners (1d)`)} value={value} extra={extra} loading={loading}
    link={`/views/get_miners_blocks_time?period=86400&view=table&order=time::desc`}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxTopAccounts(props) {
  const { accountsWeekly, stats } = props

  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      {
        key: `addr`, title: t(`Addr`),
        render: (v) => {
          if (v) {
            return <Link to={`/views/get_accounts_txs_time?period=604800&view=table&where=addr::eq::${v}&order=time::desc`}>
              {reduceText(v, 0, 7)}
            </Link>
          }
          return `--`
        }
      },
      { key: `txs`, title: t(`Txs`) },
      { key: `fees`, title: t(`Fees`) }
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra = ``

    const statsData = stats.rows[0] || {}
    //const lastBlockDate = dayjs(statsData.last_block_timestamp || 0).utc().format('YYYY-MM-DD')
    const data = []
    for (let i = 0; i < accountsWeekly.rows.length; i++) {
      const item = accountsWeekly.rows[i]
      //const date = item.time.split('T')[0]

      //if (date === lastBlockDate) {
      data.push({ addr: item.addr, txs: item.total_txs.toLocaleString(), fees: formatXelis(item.total_fees, { withSuffix: false }) })
      //}
    }

    const first = data[0]
    if (first) {
      value = reduceText(first.addr, 0, 7)
      extra = first.total_txs
    }

    return { value, extra, data }
  }, [accountsWeekly, stats])

  const { value, extra, data } = boxData
  const loading = accountsWeekly.loading

  return <Box name={t(`Top Accounts (1w)`)} value={value} extra={extra} loading={loading}
    link={`/views/get_accounts_txs_time?period=604800&view=table&order=time::desc`}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxBlockTypes(props) {
  const { blocksDaily } = props

  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `type`, title: t(`Type`) },
      { key: `count`, title: t(`Count`) },
    ]
  }, [])

  const boxData = useMemo(() => {
    let value = `--`, extra = ``

    let data = []
    const item = blocksDaily.rows[0]
    if (item) {
      data.push({ type: "Sync & Normal", count: item["sync_block_count"] })
      data.push({ type: "Side", count: item["side_block_count"] })
      data.push({ type: "Orphaned", count: item["orphaned_block_count"] })
      value = t(`{} blocks`, [item["block_count"]])
    }

    return { value, extra, data }
  }, [blocksDaily, t])

  const { value, extra, data } = boxData
  const loading = blocksDaily.loading

  return <Box name={t(`Block Types (1d)`)} value={value} extra={extra} loading={loading}
    link={`/views/blocks_by_time?columns=time,side_block_count,orphaned_block_count,sync_block_count,block_count&period=86400&view=table&order=time::desc`}>
    <BoxTable headers={headers} data={data} />
  </Box>
}

function BoxMinersDistribution(props) {
  const { minersDistributionDaily, today } = props

  const { t } = useLang()
  const chartStyle = useChartStyle()
  const { loading } = minersDistributionDaily

  const data = useMemo(() => {
    const { rows } = minersDistributionDaily
    // limit display distribution or the piechart will overlap
    return Object.assign([], rows).splice(0, 30).map((item) => {
      const { miner, total_blocks } = item
      return { name: miner, value: total_blocks }
    })
  }, [minersDistributionDaily])

  return <Box name={t(`Miners Distribution (Today)`)} loading={loading} noData={data.length === 0}
    link={`/views/get_miners_blocks_time?period=86400&view=table&where=time::eq::${today}&order=total_blocks::desc`}>
    <ResponsiveContainer>
      <PieChart>
        <Pie isAnimationActive={false} dataKey="value" data={data} innerRadius={50} {...chartStyle} outerRadius={75} paddingAngle={5} />
        <Tooltip isAnimationActive={false}
          content={({ active, payload }) => {
            if (active && payload[0]) {
              const { name, value } = payload[0]
              return <div className={boxStyle.tooltip}>
                <div>{reduceText(name)}</div>
                <div>{t(`Blocks : {}`, [value.toLocaleString()])}</div>
              </div>
            }

            return null
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  </Box>
}

function BoxSupplyEmission() {
  const { t } = useLang()

  const headers = useMemo(() => {
    return [
      { key: `approx_days`, title: t(`Year`), render: (v) => 2024 + (v / 365) },
      { key: `circulating_supply`, title: t(`Minted`), render: (v) => v.toLocaleString() },
      { key: `mined_percentage`, title: t(`%`), render: (v) => v.toLocaleString() },
    ]
  }, [])

  const data = useMemo(() => {
    return Object.assign([], supplyEmissionData).splice(1, 4).sort((a, b) => b.approx_days - a.approx_days)
  }, [supplyEmissionData])

  return <Box name={t(`Supply Emission`)}
    link={`/views/supply_emission?view=table`}>
    <BoxTable headers={headers} data={data} maxRow={4} />
  </Box>
}

function AutoUpdate(props) {
  const { onUpdate, duration = 60 * 1000 } = props

  const { t } = useLang()
  const [time, setTime] = useState(duration)
  const timeRef = useRef(duration)

  useEffect(() => {
    let intervalId = setInterval(() => {
      if (timeRef.current <= 0) {
        if (typeof onUpdate === `function`) onUpdate()
        timeRef.current = duration
        setTime(duration)
      } else {
        timeRef.current -= 1000
        setTime(timeRef.current)
      }
    }, 1000)
    return () => clearInterval(intervalId)
  }, [onUpdate, duration])

  return <div className={style.autoUpdate}>
    {t(`Auto Update in {}`, [prettyMs(time)])}
  </div>
}

function TopStats(props) {
  const { stats } = props

  const { t } = useLang()

  const data = stats.rows[0] || {}

  if (stats.loading) {
    return <div className={style.topStats}>
      <div className="loading">loading<DotLoading /></div>
    </div>
  }

  return <div className={style.topStats}>
    <div>
      <div>{t(`Topoheight`)}</div>
      <div>{data.topoheight ? data.topoheight.toLocaleString() : `--`}</div>
    </div>
    <div>
      <div>{t(`Circulating Supply`)}</div>
      <div>{formatXelis(data.circulating_supply, { withSuffix: false }) || `--`}</div>
    </div>
    <div>
      <div>{t(`Accounts`)}</div>
      <div>{data.account_count ? data.account_count.toLocaleString() : `--`}</div>
    </div>
    <div>
      <div>{t(`Txs`)}</div>
      <div>{data.tx_count ? data.tx_count.toLocaleString() : `--`}</div>
    </div>
    <div>
      <div>{t(`Contracts`)}</div>
      <div>{data.contract_count ? data.contract_count.toLocaleString() : `--`}</div>
    </div>
    <div>
      <div>{t(`Blockchain Size`)}</div>
      <div>{formatSize(data.blockchain_size) || `--`}</div>
    </div>
    <div>
      <div>{t(`Total Fees`)}</div>
      <div>{formatXelis(data.sum_fees, { withSuffix: false }) || `--`}</div>
    </div>
  </div>
}

function Home() {
  const { t } = useLang()

  const hourInSeconds = useMemo(() => 60 * 60, [])
  const dayInSeconds = useMemo(() => 60 * 60 * 24, [])
  const weekInSeconds = useMemo(() => 86400 * 7, [])
  const [reload, setReload] = useState()
  const marketAsset = `USDT`
  const today = useMemo(() => {
    return dayjs().format(`YYYY-MM-DD`)
  }, [])

  const marketTickersHourly = useFetchView({
    view: `get_market_tickers_time(*)`,
    params: { param: [hourInSeconds], where: [`asset::eq::${marketAsset}`], order: [`time::desc`], limit: 24, count: true },
    reload
  })

  const marketTickersDaily = useFetchView({
    view: `get_market_tickers_time(*)`,
    params: { param: [dayInSeconds], where: [`asset::eq::${marketAsset}`], order: [`time::desc`], limit: 7, count: true },
    reload
  })

  const marketTickersExchangeDaily = useFetchView({
    view: `get_market_tickers_exchange_time(*)`,
    params: { param: [dayInSeconds], where: [`asset::eq::${marketAsset}`, `time::eq::${today}`], order: [`time::desc`, `volume::desc`], limit: 3, count: true },
    reload
  })

  const recentBlocks = useFetchView({
    view: `blocks`,
    params: { order: [`topoheight::desc`], limit: 5, count: true },
    reload
  })

  const blocksDaily = useFetchView({
    view: `get_blocks_time(*)`,
    params: { param: [dayInSeconds], order: ["time::desc"], limit: 20, count: true },
    reload
  })

  const stats = useFetchView({
    view: `get_stats()`,
    reload
  })

  const minersDaily = useFetchView({
    view: `get_miners_blocks_time(*)`,
    params: { param: [dayInSeconds], count: true, limit: 5, order: [`time::desc`, `total_blocks::desc`], },
    reload
  })

  const minersCountDaily = useFetchView({
    view: `get_miners_count_time(*)`,
    params: { param: [dayInSeconds], count: true, limit: 20, order: [`time::desc`], },
    reload
  })

  const accountsCountDaily = useFetchView({
    view: `get_accounts_count_time(*)`,
    params: { param: [dayInSeconds], count: true, limit: 20, order: [`time::desc`], },
    reload
  })

  const accountsWeekly = useFetchView({
    view: `get_accounts_txs_time(*)`,
    params: { param: [weekInSeconds], count: true, limit: 20, order: [`time::desc`, `total_txs::desc`], },
    reload
  })

  const activeAccountsWeekly = useFetchView({
    view: `get_accounts_active_time(*)`,
    params: { param: [weekInSeconds], count: true, limit: 20, order: [`time::desc`], },
    reload
  })

  const txsDaily = useFetchView({
    view: `get_txs_time(*)`,
    params: { param: [dayInSeconds], count: true, limit: 20, order: [`time::desc`], },
    reload
  })

  const minersDistributionDaily = useFetchView({
    view: `get_miners_blocks_time(*)`,
    params: { param: [dayInSeconds], count: true, limit: 100, where: [`time::eq::${today}`], order: [`total_blocks::desc`] },
    reload
  })

  const update = useCallback(() => {
    setReload(new Date().getTime())
  }, [])

  // Transactions per minute
  const tpm = useMemo(() => {
    const item = blocksDaily.rows[0] || {}
    if (!item.sum_tx_count) return 0
    return formatNumber(item.sum_tx_count / 3600)
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
      <AutoUpdate onUpdate={update} />
    </div >
    <TopStats stats={stats} />
    <div className={style.container}>
      <div>
        <div><Icon name="coins" />{t(`Market (USDT)`)}</div>
        <div>
          <BoxTimeChart data={marketTickersHourly} areaType="monotone" name={t(`Price (1h)`)} yDataKey="price" yFormat={(v) => formatNumber(v)}
            link={`/views/market_tickers?chart_key=price&period=${hourInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={marketTickersHourly} areaType="step" name={t(`Volume (1h)`)} yDataKey="volume_diff" yFormat={(v) => formatNumber(v)}
            link={`/views/market_tickers?chart_key=volume_diff&period=${hourInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxMarketCap marketHistoryDaily={marketTickersDaily} blocksDaily={blocksDaily} />
          <BoxExchanges marketHistoryExchangeDaily={marketTickersExchangeDaily} />
        </div>
      </div>
      <div>
        <div><Icon name="cube" />{t(`Blockchain`)}</div>
        <div>
          <BoxBlocks recentBlocks={recentBlocks} />
          <BoxSupplyEmission />
          <BoxTimeChart data={blocksDaily} areaType="monostone" name={t(`Circulating Supply`)} yDataKey="cumulative_block_reward" yFormat={(v) => formatXelis(v, { withSuffix: false })}
            bottomInfo={t(`Max Supply: {}`, [(18400000).toLocaleString()])}
            link={`/views/blocks_by_time?chart_key=cumulative_block_reward&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={blocksDaily} areaType="step" name={t(`Block Size (avg)`)} yDataKey="avg_block_size" yFormat={(v) => formatSize(v)}
            link={`/views/blocks_by_time?chart_key=sum_block_size&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={blocksDaily} areaType="step" name={t(`Block Time`)} yDataKey="block_time" yFormat={(v) => prettyMs(v)}
            link={`/views/blocks_by_time?chart_key=block_time&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxBlockTypes blocksDaily={blocksDaily} />
          <BoxDevFee stats={stats} />
        </div>
      </div>
      <div>
        <div><Icon name="receipt" />{t(`Transactions`)}</div>
        <div>
          <BoxTimeChart data={blocksDaily} areaType="step" name={t(`Total`)} yDataKey="cumulative_tx_count" yFormat={(v) => v.toLocaleString()}
            link={`/views/blocks_by_time?chart_key=cumulative_tx_count&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={blocksDaily} areaType="monotone" name={t(`Txs (1d)`)} yDataKey="sum_tx_count" yFormat={(v) => v.toLocaleString()} bottomInfo={<>{tpm} TPM</>}
            link={`/views/blocks_by_time?chart_key=sum_tx_count&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={txsDaily} areaType="monotone" name={t(`Transfers (1d)`)} yDataKey="transfer_count" yFormat={(v) => v.toLocaleString()} />
          <BoxTimeChart data={blocksDaily} areaType="monotone" name={t(`Total Fees`)} yDataKey="cumulative_block_fees" yFormat={(v) => formatXelis(v, { withSuffix: false })}
            link={`/views/blocks_by_time?chart_key=cumulative_block_fees&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={blocksDaily} areaType="monotone" name={t(`Fees (1d)`)} yDataKey="sum_block_fees" yFormat={(v) => formatXelis(v, { withSuffix: false })}
            link={`/views/blocks_by_time?chart_key=sum_block_fees&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
        </div>
      </div>
      <div>
        <div><Icon name="microchip" />{t(`Mining`)}</div>
        <div>
          <BoxTimeChart data={minersCountDaily} areaType="step" name={t(`Miners (1d)`)} yName={t(`Miners`)} yDataKey="miner_count" yFormat={(v) => `${v.toLocaleString()}`}
            info={t(`The network can have way more active miners. These are only the miners who were succesful in mining at least one block.`)} yDomain={[0, 'dataMax']}
            link={`/views/get_miners_count_time?chart_key=miner_count&chart_view=area&period=${dayInSeconds}&view=chart&order=time::desc`} />
          <BoxMinersDistribution today={today} minersDistributionDaily={minersDistributionDaily} />
          <BoxTimeChart data={blocksDaily} areaType="monotone" name={t(`Hash Rate (1d)`)} yName={t(`Hash Rate (avg)`)} yDataKey="avg_difficulty" yFormat={(v) => formatHashRate(v)}
            link={`/views/blocks_by_time?chart_key=avg_difficulty&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTimeChart data={blocksDaily} areaType="monotone" name={t(`Block Reward (1d)`)} yName={t(`Reward (avg)`)} yDataKey="avg_block_reward" yFormat={(v) => formatXelis(v, { withSuffix: false })}
            link={`/views/blocks_by_time?chart_key=avg_block_reward&period=${dayInSeconds}&view=chart&chart_view=area&order=time::desc`} />
          <BoxTopMiners minersDaily={minersDaily} stats={stats} />
        </div>
      </div>
      <div>
        <div><Icon name="users" />{t(`Accounts`)}</div>
        <div>
          <BoxTimeChart data={accountsCountDaily} areaType="monotstep" name={t(`Accounts`)} yName={t(`Accounts`)} yDataKey="cumulative_account_count" yFormat={(v) => `${v.toLocaleString()}`}
            link={`/views/get_accounts_count_time?chart_key=cumulative_account_count&chart_view=area&period=${dayInSeconds}&view=chart&order=time::desc`} />
          <BoxTopAccounts accountsWeekly={accountsWeekly} stats={stats} />
          <BoxTimeChart data={accountsCountDaily} areaType="monotstep" name={t(`Registered (1d)`)} yName={t(`Accounts`)} yDataKey="account_count" yFormat={(v) => `${v.toLocaleString()}`} yDomain={[0, 'dataMax']}
            link={`/views/get_accounts_count_time?chart_key=account_count&chart_view=area&period=${dayInSeconds}&view=chart&order=time::desc`} />
          <BoxTimeChart data={activeAccountsWeekly} areaType="monotstep" name={t(`Active (1w)`)} yName={t(`Accounts`)} yDataKey="active_accounts"
            yFormat={(v) => `${v.toLocaleString()}`} info={t(`Number of accounts that sent at least one transaction.`)} yDomain={[0, 'dataMax']} />
        </div>
      </div>
      <div>
        <div><Icon name="file-code" />{t(`Contracts`)}</div>
        <div>
          <Box name="Total" value="--" noData>
            <BoxAreaChart />
          </Box>
          <Box name="Deployed (1d)" value="--" noData>
            <BoxAreaChart />
          </Box>
          <Box name="Calls" value="--" noData>
            <BoxAreaChart />
          </Box>
          <Box name="Calls (1d)" value="--" noData>
            <BoxAreaChart />
          </Box>
        </div>
      </div>
    </div>
  </div >
}

export default Home