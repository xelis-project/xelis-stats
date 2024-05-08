import React, { useCallback, useMemo, useState } from 'react'
import Table from 'xelis-explorer/src/components/table'
import { useLang } from 'g45-react/hooks/useLang'
import { reduceText, formatXelis, formatHashRate } from 'xelis-explorer/src/utils'
import PageTitle from 'xelis-explorer/src/layout/page_title'
import Hashicon from 'xelis-explorer/src/components/hashicon'
import { css } from 'goober'
import theme from 'xelis-explorer/src/style/theme'
import dayjs from 'dayjs'
import { AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Area } from 'recharts'

import { useFetchView } from '../../hooks/useFetchView'
import { useChartStyle, style as boxStyle } from '../dashboard/box'


const style = {
  container: css`
    .table-miners {
      display: flex;
      flex-direction: column;
      gap: 2em;

      ${theme.query.minDesktop} {
        flex-direction: row;
        gap: 1em;
      }

      > div {
        flex: 1;

        > :nth-child(1) {
          font-size: 1.4em;
          margin-bottom: .25em;
        }

        > :nth-child(2) {
          margin-bottom: .5em;
          color: var(--muted-color);
        }

        > :nth-child(3) {
          max-height: 500px;
          overflow: auto;
        }
      }
    }

    .blocks {
      margin-bottom: 2em;

      > :nth-child(1) {
        font-size: 1.4em;
        margin-bottom: .5em;
      }
    }

    .hashrate-chart {
      margin-bottom: 2em;

      > :nth-child(1) {
        font-size: 1.4em;
        margin-bottom: .5em;
      }

      > :nth-child(2) {
        margin-bottom: .5em;
        background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 50%)`, dark: `rgb(0 0 0 / 50%)`, light: `rgb(255 255 255 / 50%)` })};
        padding: 1em;
        border-radius: .5em;
        width: 100%; 
        height: 300px;
        position: relative;

        > select {
          right: 1em;
          top: -.9em;
          position: absolute;
          font-size: 1.2em;

          background: var(--table-td-bg-color);
          border-radius: .5em;
          padding: .25em;
          border-color: transparent;
          color: var(--text-color);
        }
      }
    }

    .miner-addr {
      display: flex;
      gap: 1em;
      align-items: center;
      gap: .5em;
    }
  `
}

function Mining() {
  const { t } = useLang()

  return <div className={style.container}>
    <PageTitle title={t('Mining Stats')} />
    <BlockTypes />
    <HashrateChart />
    <div className="table-miners">
      <TopMinersAllTime />
      <TopMinersToday />
    </div>
  </div>
}

function HashrateChart() {
  const chartStyle = useChartStyle()

  const [period, setPeriod] = useState(14400)
  const [reload, setReload] = useState()

  const data = useFetchView({
    view: `get_blocks_time(*)`,
    params: { count: true, param: [period], order: [`time::desc`] },
    reload
  })

  const items = useMemo(() => {
    const { rows = [] } = data
    return Object.assign([], rows).reverse();
  }, [data])

  const onChangePeriod = useCallback((e) => {
    setPeriod(parseInt(e.target.value))
    setReload(new Date().getTime())
  }, [])

  return <div className="hashrate-chart">
    <div>Network Hashrate</div>
    <div>
      <select value={period} onChange={onChangePeriod}>
        <option value="900">15m</option>
        <option value="3600">1h</option>
        <option value="14400">4h</option>
        <option value="86400">1d</option>
      </select>
      <ResponsiveContainer >
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
                return <div className={boxStyle.tooltip}>
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
    </div>
  </div>
}

function TopMinersAllTime(props) {
  const { t } = useLang()

  const data = useFetchView({
    view: `get_miners_blocks()`,
    params: { count: true, limit: 100, order: [`total_blocks::desc`], }
  })

  const { loading, err, count, rows } = data
  console.log(rows)
  return <div>
    <div>Top miners (All time)</div>
    <div>{count} total miners</div>
    <Table
      headers={[t(`Miner`), t(`Blocks`), t(`Rewards`)]}
      list={rows} loading={loading} err={err} emptyText={t('No miners')} colSpan={3}
      onItem={(item) => {
        return <React.Fragment key={item.miner}>
          <tr>
            <td>
              <div className="miner-addr">
                <Hashicon size={25} value={item.miner} />
                <a href={`${EXPLORER_LINK}/accounts/${item.miner}`} target="_blank">
                  {reduceText(item.miner, 0, 7)}
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
}

function TopMinersToday() {
  const { t } = useLang()

  const today = useMemo(() => {
    // 2024-04-23
    return dayjs().format("YYYY-MM-DD")
  })

  const data = useFetchView({
    view: `get_miners_blocks_time(*)`,
    params: { param: [86400], count: true, limit: 100, order: [`time::desc`, `total_blocks::desc`], where: [`time::eq::${today}`] }
  })

  const { loading, err, count, rows } = data

  return <div>
    <div>Top miners (Today)</div>
    <div>{count} total miners</div>
    <Table
      headers={[t(`Miner`), t(`Blocks`), t(`Rewards`)]}
      list={rows} loading={loading} err={err} emptyText={t('No miners')} colSpan={3}
      onItem={(item) => {
        return <React.Fragment key={item.miner}>
          <tr>
            <td>
              <div className="miner-addr">
                <Hashicon size={25} value={item.miner} />
                <a href={`${EXPLORER_LINK}/accounts/${item.miner}`} target="_blank">
                  {reduceText(item.miner, 0, 7)}
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
}

function BlockTypes() {
  const { t } = useLang()

  const data = useFetchView({
    view: `get_blocks_time(*)`,
    params: { count: false, param: [86400], order: [`time::desc`], limit: 4 },
  })

  const { loading, err, count, rows } = data

  return <div className="blocks">
    <div>{t(`Blocks (Daily)`)}</div>
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