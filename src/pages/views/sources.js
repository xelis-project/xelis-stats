import { useCallback, useMemo } from 'react'
import { formatHashRate, formatSize, formatXelis } from 'xelis-explorer/src/utils'
import { useLang } from 'g45-react/hooks/useLang'
import prettyMs from 'pretty-ms'

import { FilterMarketAssets, FilterMarketExchanges, FilterUnitPeriod, FilterTimePeriod } from './filters'
import supplyEmissionData from '../../data/supply_emission.json'
import { fetchView } from '../../hooks/useFetchView'

function useSources() {
  const { t } = useLang()

  const getBlocksTime = useCallback(({ period }) => {
    return fetchView(`get_blocks_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getMarketHistoryTime = useCallback((params) => {
    let { period, asset } = params

    const interval = 60 * 60
    const where = []
    if (asset) {
      where.push(`asset:eq:${asset}`)
    }

    return fetchView(`get_market_history_time(*)`, { count: true, param: [period], where, order: [`time:desc`] })
  }, [])

  const getBlocksTopo = useCallback(({ period }) => {
    return fetchView(`get_blocks_topo(*)`, { count: true, param: [period], order: [`max_topo:desc`] })
  }, [])

  const getExchangeHistoryTime = useCallback((params) => {
    let { period, asset, exchange } = params

    const where = []
    if (asset) {
      where.push(`asset:eq:${asset}`)
    }

    if (exchange) {
      where.push(`exchange:eq:${exchange}`)
    }

    return fetchView(`get_market_history_exchange_time(*)`, { count: true, param: [period], where, order: [`time:desc`] })
  }, [])

  const getMinersBlocksTime = useCallback(({ period }) => {
    return fetchView(`get_miners_blocks_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getAccountsCountTime = useCallback(({ period }) => {
    return fetchView(`get_accounts_count_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getAccountsActiveTime = useCallback(({ period }) => {
    return fetchView(`get_accounts_active_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getAccountsTxsTime = useCallback(({ period }) => {
    return fetchView(`get_accounts_txs_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getMinersCountTime = useCallback(({ period }) => {
    return fetchView(`get_miners_count_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getTransactionsTime = useCallback(({ period }) => {
    return fetchView(`get_txs_time(*)`, { count: true, param: [period], order: [`time:desc`] })
  }, [])

  const getTransactions = useCallback(() => {
    return fetchView(`transactions`, { count: true, order: [`nonce:desc`] })
  }, [])

  const getAccounts = useCallback(() => {
    return fetchView(`accounts`, { count: true, order: [`timestamp:desc`] })
  }, [])

  const getBlocks = useCallback(() => {
    return fetchView(`blocks`, { count: true, order: [`topoheight:desc`] })
  }, [])

  const timeItemRowKey = useCallback((item) => {
    return new Date(item.time).getTime() / 1000
  }, [])

  const getSupplyEmission = useCallback(() => {
    const rows = Object.assign([], supplyEmissionData).map((item, i) => {
      return { ...item, year: i }
    }).reverse() // https://stackoverflow.com/questions/65408588/lightweight-charts-uncaught-error-value-is-null
    return Promise.resolve({ rows })
  }, [])

  return useMemo(() => [
    {
      key: `blocks`,
      title: t(`Blocks`),
      description: t(`List all blocks.`),
      rowKey: `topoheight`,
      getData: getBlocks,
      timeFormatter: (v) => v,
      columns: [
        { key: `hash`, title: t(`Hash`), views: [`table`] },
        { key: `topoheight`, title: t(`Topoheight`), views: [`table`] },
        { key: `timestamp`, title: t(`Timestamp`), views: [`table`] },
        { key: `block_type`, title: t(`Block Type`), views: [`table`] },
        { key: `cumulative_difficulty`, title: t(`Cumulative Difficulty`) },
        { key: `supply`, title: t(`Supply`) },
        { key: `difficulty`, title: t(`Difficulty`) },
        { key: `reward`, title: t(`Reward`) },
        { key: `height`, title: t(`Height`), views: [`table`] },
        { key: `miner`, title: t(`Miner`), views: [`table`] },
        { key: `nonce`, title: t(`Nonce`), views: [`table`] },
        { key: `total_fees`, title: t(`Total Fees`) },
        { key: `total_size_in_bytes`, title: t(`Total Size`) },
        { key: `tx_count`, title: t(`TX Count`) },
        { key: `version`, title: t(`Version`), views: [`table`] },
      ]
    },
    {
      key: `accounts`,
      title: t(`Accounts`),
      description: t(`List all accounts.`),
      getData: getAccounts,
      columns: [
        { key: `addr`, title: t(`Hash`), views: [`table`] },
        { key: `timestamp`, title: t(`Timestamp`), views: [`table`] },
        { key: `topoheight`, title: t(`Topoheight`), views: [`table`] },
      ]
    },
    {
      key: `transactions`,
      title: t(`Transactions`),
      description: t(`List all transactions.`),
      rowKey: `hash`,
      getData: getTransactions,
      timeFormatter: (v) => v,
      columns: [
        { key: `hash`, title: t(`Hash`), views: [`table`] },
        { key: `fee`, title: t(`Fee`) },
        { key: `nonce`, title: t(`Nonce`), views: [`table`] },
        { key: `owner`, title: t(`owner`), views: [`table`] },
        { key: `signature`, title: t(`Signature`), views: [`table`] },
        { key: `executed_in_block`, title: t(`Block`), views: [`table`] },
        { key: `version`, title: t(`Version`), views: [`table`] },
        { key: `total_transfers`, title: t(`Transfers`) },
      ]
    },
    {
      key: `blocks_by_time`,
      title: t(`Blocks (Time)`),
      description: t(`Aggregate data of blocks through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getBlocksTime,
      filters: [
        <FilterTimePeriod />
      ],
      columns: [
        { key: `time`, title: t(`Period (Time)`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },

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
      title: t(`Blocks (Topoheight)`),
      description: t(`Aggregate data of blocks by topo height.`),
      rowKey: `max_topo`,
      filters: [
        <FilterUnitPeriod />
      ],
      getData: getBlocksTopo,
      timeFormatter: (v) => v,
      columns: [
        { key: `topo_range`, title: t(`Period (Topo)`), format: (v, item) => `${item.min_topo} - ${item.max_topo}`, views: [`table`] },

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
      title: t(`Market History (Time)`),
      description: t(`Aggregate data of multiple market exchanges through time-based interval.`),
      rowKey: timeItemRowKey,
      filters: [
        <FilterTimePeriod />,
        <FilterMarketAssets />
      ],
      getData: getMarketHistoryTime,
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
          key: `price_candle`, title: t(`Price & Volume`),
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
      title: t(`Exchange History (Time)`),
      description: t(`Market history of a specific exchange through time-based interval.`),
      rowKey: timeItemRowKey,
      filters: [
        <FilterTimePeriod />,
        <FilterMarketAssets />,
        <FilterMarketExchanges />
      ],
      getData: getExchangeHistoryTime,
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
          key: `price_candle`, title: t(`Price & Volume`),
          candle: { highKey: `max_price`, lowKey: `min_price`, openKey: `first_price`, closeKey: `last_price` },
          bottomChartKey: "sum_quantity"
        }
      ],
    },
    {
      key: `get_txs_time`,
      title: t(`Transactions (Time)`),
      description: t(`Aggregate data of transactions through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getTransactionsTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `transfer_count`, title: t(`Transfer Count`), format: (v) => `${v.toLocaleString()}` },
      ]
    },
    {
      key: `get_miners_count_time`,
      title: t(`Total Miners (Time)`),
      description: t(`Number of miners through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getMinersCountTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `miner_count`, title: t(`Miner Count`), format: (v) => `${v.toLocaleString()}` },
      ]
    },
    {
      key: `get_miners_blocks_time`,
      title: t(`Miners Blocks (Time)`),
      description: t(`Miner data by address through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getMinersBlocksTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `miner`, title: t(`Miner`), views: [`table`] },
        { key: `total_blocks`, title: t(`Total Blocks`), format: (v) => `${v.toLocaleString()}` },
        { key: `total_reward`, title: t(`Total Reward`), format: (v) => formatXelis(v) },
      ]
    },
    {
      key: `get_accounts_count_time`,
      title: t(`Total Accounts (Time)`),
      description: t(`Number of accounts through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getAccountsCountTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `account_count`, title: t(`Accounts`), format: (v) => `${v.toLocaleString()}` },
        { key: `cumulative_account_count`, title: t(`Accounts (Cumulative)`), format: (v) => `${v.toLocaleString()}` },
      ]
    },
    {
      key: `get_accounts_active_time`,
      title: t(`Active Accounts (Time)`),
      description: t(`Number of active/inactive accounts through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getAccountsActiveTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `active_accounts`, title: t(`Active Accounts`), format: (v) => `${v.toLocaleString()}` },
        { key: `inactive_accounts`, title: t(`Inactive Accounts`), format: (v) => `${v.toLocaleString()}` },
      ]
    },
    {
      key: `get_accounts_txs_time`,
      title: t(`Account Transactions (Time)`),
      description: t(`Account fees & transactions through time-based interval.`),
      rowKey: timeItemRowKey,
      getData: getAccountsTxsTime,
      filters: [
        <FilterTimePeriod />,
      ],
      columns: [
        { key: `time`, title: t(`Time`), format: (v) => new Date(v).toLocaleString(), views: [`table`] },
        { key: `addr`, title: t(`Address`), views: [`table`] },
        { key: `total_txs`, title: t(`Total Transactions`), format: (v) => `${v.toLocaleString()}` },
        { key: `total_fees`, title: t(`Total Fees`), format: (v) => formatXelis(v) },
      ]
    },
  ], [t])
}

export default useSources
