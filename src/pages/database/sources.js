import { useCallback, useMemo } from 'react'
import { formatHashRate, formatSize, formatXelis } from 'xelis-explorer/src/utils'
import { useLang } from 'g45-react/hooks/useLang'
import prettyMs from 'pretty-ms'

import supabase from '../../hooks/useSupabase'
import { FilterMarketAssets, FilterMarketExchanges, FilterUnitRange, FilterTimeRange } from './filters'
import supplyEmissionData from '../../data/supply_emission.json'

function useSources() {
  const { t } = useLang()

  const getBlocksTime = useCallback(({ range }) => {
    return supabase
      .rpc(`get_blocks_time`, { time_range: range }, { count: 'exact' })
      .order(`time`, { ascending: false })
  }, [])

  const getBlocksTimeNew = useCallback(async (query) => {
    let { start_timestamp, end_timestamp } = query
    //end_timestamp = Math.round(new Date().getTime() / 1000)
    //start_timestamp = end_timestamp - 31536000
    return supabase
      .rpc(`get_blocks_time_new`, { start_timestamp, end_timestamp }, { count: 'exact' })
      .order(`time`, { ascending: false })
  }, [])

  const getMarketHistoryTimeNew = useCallback((params) => {
    let { start_timestamp, end_timestamp, asset } = params
    const query = supabase.rpc(`get_market_history_new`, { start_timestamp, end_timestamp }, { count: `exact` })
    if (asset) query.eq(`asset`, asset)
    query.order(`time`, { ascending: false })
    return query
  }, [])

  const getBlocksRange = useCallback(({ range }) => {
    return supabase
      .rpc(`get_blocks_range`, { range }, { count: `exact` })
      .order(`max_topo`, { ascending: false })
      .limit(250)
  }, [])

  const getMarketHistoryTime = useCallback(({ range }) => {
    return supabase
      .rpc(`get_market_history`, { time_range: range }, { count: `exact` })
      .order(`time`, { ascending: false })
  }, [])

  const getExchangeHistoryTimeNew = useCallback((params) => {
    let { start_timestamp, end_timestamp, asset, exchange } = params
    const query = supabase.rpc(`get_market_history_exchange_new`, { start_timestamp, end_timestamp }, { count: `exact` })
    if (asset) query.eq(`asset`, asset)
    if (exchange) query.eq(`exchange`, exchange)
    query.order(`time`, { ascending: false })
    return query
  }, [])

  const getExchangeHistoryTime = useCallback(({ range }) => {
    return supabase
      .rpc(`get_market_history_exchange`, { time_range: range }, { count: `exact` })
      .order(`time`, { ascending: false })
  }, [])

  const getMinersBlocksTime = useCallback(({ range }) => {
    return supabase
      .rpc(`get_miners_blocks_time`, { time_range: range }, { count: `exact` })
      .order(`time`, { ascending: false })
  }, [])

  const timeItemRowKey = useCallback((item) => {
    return new Date(item.time).getTime() / 1000
  }, [])

  const getSupplyEmission = useCallback(() => {
    const data = Object.assign([], supplyEmissionData).map((item, i) => {
      return { ...item, year: i }
    }).reverse() // https://stackoverflow.com/questions/65408588/lightweight-charts-uncaught-error-value-is-null
    return Promise.resolve({ data })
  }, [])

  return useMemo(() => [
    {
      key: `blocks_by_time`,
      title: t(`Blocks (Time)`),
      description: t(`Aggregate data of blocks through time-based interval.`),
      rowKey: timeItemRowKey,
      //getQuery: getBlocksTime,
      getData: getBlocksTimeNew,
      filters: [
        <FilterTimeRange />
      ],
      //range: `time`,
      //defaultRangeValue: 'day',
      columns: [
        { key: `time`, title: t(`Range (Time)`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },

        { key: `block_count`, title: t(`Block Count (sum)`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_block_count`, title: t(`Block Count (cumulative)`), format: (v) => `${v.toLocaleString()}` },
        { key: `sync_block_count`, title: t(`Block Count (sync)`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_sync_block_count`, title: t(`Block Count (sync | cumulative)`), format: (v) => `${v.toLocaleString()}` },
        { key: `side_block_count`, title: t(`Block Count (side)`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_side_block_count`, title: t(`Block Count (side | cumulative)`), format: (v) => `${v.toLocaleString()}` },
        { key: `orphaned_block_count`, title: t(`Block Count (orphaned)`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_orphaned_block_count`, title: t(`Block Count (orphaned | cumulative)`), format: (v) => `${v.toLocaleString()}` },

        { key: `sum_block_fees`, title: t(`Block Fees (sum)`), format: (v) => formatXelis(v) },
        { key: `avg_block_fees`, title: t(`Block Fees (avg)`), format: (v) => formatXelis(v) },
        { key: `cumulative_block_fees`, title: t(`Block Fees (cumulative)`), format: (v) => formatXelis(v) },
        { key: `min_block_fees`, title: t(`Block Fees (min)`), format: (v) => formatXelis(v) },
        { key: `max_block_fees`, title: t(`Block Fees (max)`), format: (v) => formatXelis(v) },

        { key: `avg_block_reward`, title: t(`Block Reward (avg)`), format: (v) => formatXelis(v) },
        { key: `sum_block_reward`, title: t(`Block Reward (sum)`), format: (v) => formatXelis(v) },
        { key: `cumulative_block_reward`, title: t(`Block Reward (cumulative)`), format: (v) => formatXelis(v) },

        { key: `avg_tx_count`, title: t(`TX Count (avg)`), format: (v) => `${v.toLocaleString()}` },
        { key: `sum_tx_count`, title: t(`TX Count (sum)`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_tx_count`, title: t(`TX Count (cumulative)`), format: (v) => `${v.toLocaleString()}` },
        { key: `min_tx_count`, title: t(`TX Count (min)`), format: (v) => `${v.toLocaleString()}` },
        { key: `max_tx_count`, title: t(`TX Count (max)`), format: (v) => `${v.toLocaleString()}` },

        { key: `avg_difficulty`, title: t(`Hash Rate (avg)`), format: (v) => formatHashRate(v / 15) },
        { key: `min_difficulty`, title: t(`Hash Rate (min)`), format: (v) => formatHashRate(v / 15) },
        { key: `max_difficulty`, title: t(`Hash Rate (max)`), format: (v) => formatHashRate(v / 15) },

        { key: `avg_block_size`, title: t(`Block Size (avg)`), format: (v) => formatSize(v) },
        { key: `sum_block_size`, title: t(`Block Size (sum)`), format: (v) => formatSize(v) },
        { key: `cumulative_block_size`, title: t(`Block Size (cumulative)`), format: (v) => formatSize(v) },
        { key: `min_block_size`, title: t(`Block Size (min)`), format: (v) => formatSize(v) },
        { key: `max_block_size`, title: t(`Block Size (max)`), format: (v) => formatSize(v) },

        { key: `supply`, title: t(`Supply`), format: (v) => formatXelis(v) },
        { key: `block_time`, title: t(`Block Time (avg)`), format: (v) => `${prettyMs(v)}` },
        {
          key: `diff_candle`, title: t(`Hash Rate`), format: (v) => formatHashRate(v / 15),
          candle: { highKey: `max_difficulty`, lowKey: `min_difficulty`, openKey: `first_difficulty`, closeKey: `last_difficulty` },
        },
      ]
    },
    {
      key: `blocks_by_range`,
      title: t(`Blocks (Topo)`),
      description: t(`Aggregate data of blocks by topo height.`),
      rowKey: `max_topo`,
      filters: [
        <FilterUnitRange />
      ],
      getData: getBlocksRange,
      timeFormatter: (v) => v,
      columns: [
        { key: `topo_range`, title: t(`Range (Topo)`), format: (v, item) => `${item.min_topo} - ${item.max_topo}`, views: [`table`] },

        { key: `avg_difficulty`, title: t(`Hash Rate (avg)`), format: (v) => formatHashRate(v / 15) },

        { key: `sum_tx_count`, title: t(`TX Count (sum)`), format: (v) => `${v.toLocaleString()}`, maxKey: `max_tx_count`, minKey: `min_tx_count` },
        { key: `avg_tx_count`, title: t(`TX Count (avg)`), format: (v) => `${v.toLocaleString()}` },

        { key: `sum_block_reward`, title: t(`Block Reward (sum)`), format: (v) => formatXelis(v) },
        { key: `avg_block_reward`, title: t(`Block Reward (avg)`), format: (v) => formatXelis(v) },

        { key: `sum_block_size`, title: t(`Block Size (sum)`), format: (v) => formatSize(v) },
        { key: `avg_block_size`, title: t(`Block Size (avg)`), format: (v) => formatSize(v) },

        { key: `sum_total_fees`, title: t(`Block Fees (sum)`), format: (v) => formatXelis(v) },
        { key: `avg_total_fees`, title: t(`Block Fees (avg)`), format: (v) => formatXelis(v) },

        { key: `supply`, title: t(`Circulating Supply`), format: (v) => formatXelis(v) },
      ]
    },
    {
      key: `market_history`,
      title: t(`Market History`),
      description: t(`Aggregate data of multiple market exchanges.`),
      rowKey: timeItemRowKey,
      filters: [
        <FilterTimeRange />,
        <FilterMarketAssets />
      ],
      //range: `time`,
      getData: getMarketHistoryTimeNew,
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `asset`, title: t(`Asset`), views: [`table`] },
        { key: `first_price`, title: t(`Price (first)`) },
        { key: `last_price`, title: t(`Price (last)`) },
        { key: `min_price`, title: t(`Price (min)`) },
        { key: `max_price`, title: t(`Price (max)`) },
        { key: `avg_price`, title: t(`Price (avg)`) },
        { key: `min_quantity`, title: t(`Volume (min)`) },
        { key: `max_quantity`, title: t(`Volume (max)`) },
        { key: `avg_quantity`, title: t(`Volume (avg)`) },
        { key: `sum_quantity`, title: t(`Volume (sum)`) },
        { key: `trade_count`, title: t(`Trade Count`) },
        { key: `total_price`, title: t(`Total Price`) },
        {
          key: `price_candle`, title: t(`Price`),
          candle: { highKey: `max_price`, lowKey: `min_price`, openKey: `first_price`, closeKey: `last_price` },
          bottomChartKey: "sum_quantity"
        }
      ],
    },
    {
      key: `supply_emission`,
      title: t(`Supply Emission (Simulation)`),
      description: t(`Circulating supply from start to end.`),
      rowKey: `year`,
      getData: getSupplyEmission,
      timeFormatter: (v) => `${v}y`,
      columns: [
        { key: `year`, title: t(`Year`), views: [`table`] },
        { key: `circulating_supply`, title: t(`Circulating Supply`), format: (v) => formatXelis(v) },
        { key: `dev_supply`, title: t(`Dev Supply`), format: (v) => formatXelis(v) },
        { key: `supply_left`, title: t(`Supply Left`), format: (v) => formatXelis(v) },
        { key: `mined_percentage`, title: t(`Mined Percentage`), format: (v) => `${v}%` },
      ]
    },
    {
      key: `get_market_history_exchange`,
      title: t(`Exchange History`),
      description: t(`Market history of a specific exchange.`),
      rowKey: timeItemRowKey,
      filters: [
        <FilterTimeRange />,
        <FilterMarketAssets />,
        <FilterMarketExchanges />
      ],
      getData: getExchangeHistoryTimeNew,
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `asset`, title: t(`Asset`), views: [`table`] },
        { key: `exchange`, title: t(`Exchange`), views: [`table`] },
        { key: `first_price`, title: t(`Price (first)`) },
        { key: `last_price`, title: t(`Price (last)`) },
        { key: `min_price`, title: t(`Price (min)`) },
        { key: `max_price`, title: t(`Price (max)`) },
        { key: `avg_price`, title: t(`Price (avg)`) },
        { key: `min_quantity`, title: t(`Volume (min)`) },
        { key: `max_quantity`, title: t(`Volume (max)`) },
        { key: `avg_quantity`, title: t(`Volume (avg)`) },
        { key: `sum_quantity`, title: t(`Volume (sum)`) },
        { key: `trade_count`, title: t(`Trade Count`) },
        { key: `total_price`, title: t(`Total Price`) },
        {
          key: `price_candle`, title: t(`Price`),
          candle: { highKey: `max_price`, lowKey: `min_price`, openKey: `first_price`, closeKey: `last_price` }
        }
      ],
    },
    {
      key: `get_txs_time`,
      title: t(`Transactions (Time)`),
      description: t(`Aggregate data of transactions through time-based interval.`),
      range: `time`,
      rowKey: timeItemRowKey,
    },
    {
      key: `get_miners_count_time`,
      title: t(`Miners (Time)`),
      description: t(`Number of miners through time-based interval.`),
      range: `time`,
      rowKey: timeItemRowKey,
    },
    {
      key: `get_miners_blocks_time`,
      title: t(`Miners Blocks (Time)`),
      description: t(`Miner data by address through time-based interval.`),
      range: `time`,
      rowKey: timeItemRowKey,
      getQuery: getMinersBlocksTime,
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `miner`, title: t(`Miner`), views: [`table`] },
        { key: `total_blocks`, title: t(`Total Blocks`), views: [`table`], format: (v) => `${v.toLocaleString()}` },
        { key: `total_reward`, title: t(`Total Reward`), views: [`table`], format: (v) => formatXelis(v) },
      ]
    }
  ], [t])
}

export default useSources
