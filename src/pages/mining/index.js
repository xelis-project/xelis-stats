import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Table from 'xelis-explorer/src/components/table'
import { useLang } from 'g45-react/hooks/useLang'
import { formatXelis, formatHashRate } from 'xelis-explorer/src/utils'
import PageTitle from 'xelis-explorer/src/layout/page_title'
import Hashicon from 'xelis-explorer/src/components/hashicon'
import dayjs from 'dayjs'
import { AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, LineChart, Line } from 'recharts'
import Icon from 'g45-react/components/fontawesome_icon'
import { formatMiner } from 'xelis-explorer/src/utils/pools'

import { fetchView, useFetchView } from '../../hooks/useFetchView'
import { useChartStyle } from '../dashboard/box'
import boxStyle from '../dashboard/box/style'
import style from './style'

function Mining() {
  const { t } = useLang()

  return <div >
    <PageTitle title={t('Mining Stats')} />
    <div className={style.container}>
      <BlockTypes />
      <HashrateChart />
      <TopMinersComparison />
      <div className={style.twoRow.container}>
        <TopMinersAllTime />
        <TopMinersToday />
      </div>
    </div>
  </div>
}

function HashrateChart() {
  const chartStyle = useChartStyle()
  const { t } = useLang()

  const [period, setPeriod] = useState(14400)

  const blocksTime = useFetchView({
    view: `get_blocks_time(*)`,
    params: { count: true, param: [period], order: [`time::desc`] },
    fetchOnLoad: false
  })

  const onChangePeriod = useCallback((e) => {
    setPeriod(parseInt(e.target.value))
  }, [])

  useEffect(() => {
    blocksTime.fetch()
  }, [period])

  const { loading, rows } = blocksTime
  const items = Object.assign([], rows).reverse()

  return <div>
    <div className={style.title}>{t(`Network Hashrate`)}</div>
    <div className={style.chart.container}>
      <select className={style.chart.select} value={period} onChange={onChangePeriod}>
        <option value="900">15m</option>
        <option value="3600">1h</option>
        <option value="14400">4h</option>
        <option value="86400">1d</option>
      </select>
      <ResponsiveContainer>
        <AreaChart
          data={items}
          margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
        >
          <XAxis dataKey="time"
            tickFormatter={(time) => {
              return new Date(time).toLocaleDateString()
            }}
          />
          <YAxis
            tickFormatter={(diff) => {
              return formatHashRate(diff)
            }}
          />
          <Tooltip isAnimationActive={false}
            content={({ active, payload }) => {
              if (active && payload && payload[0]) {
                const { name, value, payload: item } = payload[0]
                return <div className={boxStyle.chart.tooltip}>
                  <div>{item[`time`]}</div>
                  <div>{formatHashRate(value)}</div>
                </div>
              }
              return null
            }}
          />
          <Area type="monotone" dataKey="avg_difficulty" isAnimationActive={false} strokeWidth={1} {...chartStyle} />
        </AreaChart>
      </ResponsiveContainer>
      {loading && <div className={style.chart.loading}>
        <Icon name="circle-notch" className="fa-spin" />
      </div>}
    </div>
  </div>
}

function TopMinersComparison() {
  const chartStyle = useChartStyle()
  const { t } = useLang()

  const period = 86400 * 7 // week
  const limit = 10
  const yesterday = useMemo(() => dayjs().add(-1).format("YYYY-MM-DD"), [])

  // const [miners, setMiners] = useState([])
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState({})

  const colors = useMemo(() => [`red`, `blue`, `yellow`, `green`, `cyan`, `orange`])

  const load = useCallback(async () => {
    const views = []
    setLoading(true)

    function setErr(err) {
      setLoading(false)
      console.log(err)
    }

    const miners = await fetchView(`get_miners_blocks_time(*)`, {
      param: [86400], limit: 6, count: true, order: [`total_blocks::desc`],
      where: [`time::eq::${yesterday}`]
    }).catch((err) => setErr(err))

    miners.rows.forEach((row) => {
      const { miner } = row
      views.push(fetchView(`get_miners_blocks_time(*)`, {
        param: [period], limit: limit, count: true, order: [`time::desc`],
        where: [`miner::eq::${miner}`]
      }))
    })

    const results = await Promise.all(views).catch((err) => setErr(err))
    const data = {}

    function parse(rows, key) {
      rows.forEach((row) => {
        const { time, total_blocks, miner } = row
        if (data[time]) {
          data[time] = { ...data[time], [`${key}_miner`]: miner, [`${key}_blocks`]: total_blocks }
        } else {
          data[time] = { [`${key}_miner`]: miner, [`${key}_blocks`]: total_blocks }
        }
      })
    }

    results.forEach((result, i) => {
      parse(result.rows, `m${i}`)
    })

    const items = Object.keys(data).map((key) => {
      return { time: key, ...data[key] }
    }).sort((a, b) => new Date(a.time) - new Date(b.time))

    setItems(items)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [])

  return <div>
    <div className={style.title}>{t(`Top Miners (Monthly)`)}</div>
    <div className={style.chart.container}>
      <ResponsiveContainer>
        <LineChart
          data={items}
          margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
        >
          <XAxis dataKey="time"
            tickFormatter={(time) => {
              return new Date(time).toLocaleDateString()
            }}
          />
          <YAxis
            tickFormatter={(value) => {
              return value
            }}
          />
          <Tooltip isAnimationActive={false}
            content={({ active, payload }) => {
              if (active && payload && payload[0]) {
                const { payload: data } = payload[0]
                return <div className={boxStyle.chart.tooltip}>
                  <div>{new Date(data[`time`]).toLocaleDateString()}</div>
                  {colors.map((color, i) => {
                    return <TooltipMiner key={i} miner={data[`m${i}_miner`]} value={data[`m${i}_blocks`]} style={{ color }} />
                  })}
                </div>
              }
              return null
            }}
          />
          {colors.map((color, i) => {
            return <Line key={i} type="monotone" dataKey={`m${i}_blocks`} isAnimationActive={false} strokeWidth={1} {...chartStyle} stroke={color} />
          })}
        </LineChart>
      </ResponsiveContainer>
      {loading && <div className={style.chart.loading}>
        <Icon name="circle-notch" className="fa-spin" />
      </div>}
    </div>
  </div>
}

function TooltipMiner(props) {
  const { miner, value, ...restProps } = props
  return <div className={style.chart.tooltipMiner} {...restProps}>
    <div>{formatMiner(miner)}</div>
    <div>{value}</div>
  </div>
}

function TopMinersAllTime(props) {
  const { t } = useLang()

  const minersBlocks = useFetchView({
    view: `get_miners_blocks()`,
    params: { count: true, limit: 100, order: [`total_blocks::desc`], }
  })

  const { loading, err, count, rows } = minersBlocks

  return <div className={style.twoRow.content}>
    <div className={style.title}>Top miners (All time)</div>
    <div className={style.subtitle}>{count} total miners</div>
    <div className={style.twoRow.overflow}>
      <Table
        headers={[t(`Miner`), t(`Blocks`), t(`Rewards`)]}
        list={rows} loading={loading} err={err} emptyText={t('No miners')} colSpan={3}
        onItem={(item) => {
          return <React.Fragment key={item.miner}>
            <tr>
              <td>
                <div className={style.minerAddr}>
                  <Hashicon size={25} value={item.miner} />
                  <a href={`${EXPLORER_LINK}/accounts/${item.miner}`} target="_blank">
                    {formatMiner(item.miner)}
                  </a>
                </div>

              </td>
              <td>{item.total_blocks}</td>
              <td>{formatXelis(item.total_reward)}</td>
            </tr>
          </React.Fragment>
        }}
      />
    </div>

  </div>
}

function TopMinersToday() {
  const { t } = useLang()

  const today = useMemo(() => {
    // 2024-04-23
    return dayjs().format("YYYY-MM-DD")
  })

  const minersBlocksTime = useFetchView({
    view: `get_miners_blocks_time(*)`,
    params: { param: [86400], count: true, limit: 100, order: [`time::desc`, `total_blocks::desc`], where: [`time::eq::${today}`] }
  })

  const { loading, err, count, rows } = minersBlocksTime

  return <div className={style.twoRow.content}>
    <div className={style.title}>Top miners (Today)</div>
    <div className={style.subtitle}>{count} total miners</div>
    <div className={style.twoRow.overflow}>
      <Table
        headers={[t(`Miner`), t(`Blocks`), t(`Rewards`)]}
        list={rows} loading={loading} err={err} emptyText={t('No miners')} colSpan={3}
        onItem={(item) => {
          return <React.Fragment key={item.miner}>
            <tr>
              <td>
                <div className={style.minerAddr}>
                  <Hashicon size={25} value={item.miner} />
                  <a href={`${EXPLORER_LINK}/accounts/${item.miner}`} target="_blank">
                    {formatMiner(item.miner)}
                  </a>
                </div>
              </td>
              <td>{item.total_blocks}</td>
              <td>{formatXelis(item.total_reward)}</td>
            </tr>
          </React.Fragment>
        }}
      />
    </div>
  </div>
}

function BlockTypes() {
  const { t } = useLang()

  const blocksTime = useFetchView({
    view: `get_blocks_time(*)`,
    params: { count: false, param: [86400], order: [`time::desc`], limit: 4 },
  })

  const { loading, err, rows } = blocksTime

  return <div>
    <div className={style.title}>{t(`Blocks (Daily)`)}</div>
    <Table
      headers={[t(`Time`), t(`Sync`), t(`Side`), t(`Orphaned`), t(`Txs`), t(`Tx Fees`)]}
      list={rows} loading={loading} err={err} emptyText={t('No miners')} colSpan={6}
      onItem={(item) => {
        return <React.Fragment key={item.time}>
          <tr>
            <td>{new Date(item.time).toLocaleDateString()}</td>
            <td>{item.sync_block_count.toLocaleString()}</td>
            <td>{item.side_block_count.toLocaleString()}</td>
            <td>{item.orphaned_block_count.toLocaleString()}</td>
            <td>{item.sum_tx_count.toLocaleString()}</td>
            <td>{formatXelis(item.sum_block_fees)}</td>
          </tr>
        </React.Fragment>
      }}
    />
  </div>
}

export default Mining