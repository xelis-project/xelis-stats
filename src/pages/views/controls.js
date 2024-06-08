import { useCallback, useState, useMemo, cloneElement } from 'react'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import { saveAs } from 'file-saver'
import { useLang } from 'g45-react/hooks/useLang'
import Button from 'xelis-explorer/src/components/button'
import { useNavigate } from 'react-router-dom'

import { useNotification } from 'xelis-explorer/src/components/notifications'

import style from './style'

function Controls(props) {
  const { sources, source, dataSource, query, setQuery, list, chartRef } = props
  const { t } = useLang()

  const navigate = useNavigate()
  const { pushNotification } = useNotification()

  const sourceList = useMemo(() => {
    return sources.map((source) => {
      return { key: source.key, text: source.title }
    })
  }, [sources])

  const viewTypes = useMemo(() => {
    return [
      { key: `chart`, text: `Chart` },
      { key: `table`, text: `Table` },
    ]
  }, [])

  const chartTypes = useMemo(() => {
    return [
      { key: `area`, text: `Area` },
      { key: `candlestick`, text: `Candlestick` },
      { key: `histogram`, text: `Histogram` },
      { key: `line`, text: `Line` },
    ]
  }, [])

  const chartColumns = useMemo(() => {
    const columns = (source.columns || []).filter((column) => {
      const { views, candle } = column
      if (Array.isArray(views) && views.indexOf(query.chart_view) === -1) return false

      if (query.chart_view === `candlestick` && !candle) return false
      if (query.chart_view !== `candlestick` && candle) return false

      return true
    })

    return columns.map((column) => ({ key: column.key, text: column.title }))
  }, [source, query.chart_view])

  const copyShareLink = useCallback(async () => {
    try {
      const link = window.location.href
      await navigator.clipboard.writeText(link)
      pushNotification({ icon: `clipboard`, title: t(`Info`), description: t(`Link was copied.`) })
    } catch (err) {
      console.log(err)
    }
  }, [])

  const exportData = useCallback(() => {
    const dataFile = new File([JSON.stringify(list, null, 2)], "chart_data.json", { type: "text/plain;charset=utf-8" })
    saveAs(dataFile)
  }, [list])

  const clipChart = useCallback(async () => {
    if (!chartRef.current) return
    if (!navigator.clipboard.write) return

    const canvas = chartRef.current.takeScreenshot()
    canvas.toBlob(async (blob) => {
      try {
        const item = new ClipboardItem({
          [blob.type]: blob
        })
        await navigator.clipboard.write([item])
        pushNotification({ icon: `clipboard`, title: t(`Info`), description: t(`The chart screenshot was copied.`) })
      } catch (err) {
        console.log(err)
      }
    })
  }, [])

  return <div className={style.controls}>
    <div className={style.actionButtons}>
      <Button icon="link" onClick={copyShareLink}>
        {t(`Copy Link`)}
      </Button>
      {query.view !== `table` && <Button icon="camera" onClick={clipChart}>
        {t(`Clip Chart`)}
      </Button>}
      <Button icon="file-arrow-down" onClick={exportData}>
        {t(`Export`)}
      </Button>
    </div>
    <div className={style.dropdowns}>
      <div>
        <div>Data Source</div>
        <Dropdown items={sourceList} value={dataSource} onChange={(item) => {
          navigate(`/views/${item.key}`)
          //setQuery({ data_source: item.key }) // reset query and apply new data_source
        }} />
      </div>
      {(source.filters || []).map((component, index) => {
        return cloneElement(component, { key: index, query, setQuery })
      })}
      <div>
        <div>{t(`View`)}</div>
        <Dropdown items={viewTypes} value={query.view} onChange={(item) => {
          setQuery({ ...query, view: item.key })
        }} />
      </div>
      {query.view === `chart` && <>
        <div>
          <div>{t(`Chart Type`)}</div>
          <Dropdown items={chartTypes} value={query.chart_view} onChange={(item) => {
            setQuery({ ...query, chart_view: item.key })
          }} />
        </div>
        <div>
          <div>{t(`Chart Key`)}</div>
          <Dropdown items={chartColumns} value={query.chart_key} onChange={(item) => {
            setQuery({ ...query, chart_key: item.key })
          }} />
          <MinMaxCheckbox query={query} setQuery={setQuery} />
        </div>
      </>}
    </div>
    <TableColumns source={source} query={query} setQuery={setQuery} />
  </div>
}

function MinMaxCheckbox(props) {
  const { query, setQuery } = props
  const { t } = useLang()

  const checked = useMemo(() => {
    if (query.min_max === `false`) return false
    return true
  }, [query])

  const onChange = useCallback((e) => {
    setQuery({ ...query, min_max: e.target.checked ? `true` : `false` })
  }, [query])

  return <div>
    <input type="checkbox" defaultChecked={checked} onChange={onChange} />&nbsp;{t(`Show Min/Max`)}
  </div>
}

function TableColumns(props) {
  const { source, query, setQuery } = props
  const { t } = useLang()

  const tableColumns = useMemo(() => {
    return (source.columns || []).filter((column) => {
      if (column.candle) return false
      return true
    })
  }, [source.columns])

  const showAllColumns = useCallback((e) => {
    if (e.target.checked) {
      const newQuery = Object.assign({}, query)
      Reflect.deleteProperty(newQuery, `columns`)
      setQuery(newQuery)
    } else {
      setQuery({ ...query, columns: `` })
    }
  }, [query])

  const visibleColumns = useMemo(() => {
    if (!query.columns) return []
    return query.columns.split(`,`)
  }, [query])

  const columnKeys = useMemo(() => {
    return tableColumns.map(column => column.key)
  }, [tableColumns])

  const orders = useMemo(() => {
    let orders = []
    if (Array.isArray(query.order)) {
      orders = query.order
    } else {
      orders = [query.order]
    }

    const obj = {}
    orders.forEach((order) => {
      if (!order) return

      const values = order.split('::')
      const key = values[0]
      const direction = values[1]
      obj[key] = direction
    })
    return obj
  }, [query.order])

  const wheres = useMemo(() => {
    let wheres = []
    if (Array.isArray(query.where)) {
      wheres = query.where
    } else {
      wheres = [query.where]
    }

    const obj = {}
    wheres.forEach((where) => {
      if (!where) return

      const values = where.split('::')
      const key = values[0]
      const op = values[1]
      const value = values[2]
      obj[key] = { op, value }
    })
    return obj
  }, [query.where])

  return <div className={style.columns.container}>
    <div className={style.columns.header}>
      <div>{t(`Columns ({})`, [tableColumns.length])}</div>
      <div>
        <input type="checkbox" checked={query.columns == null} onChange={showAllColumns} />
        <div>{t(`Show All`)}</div>
      </div>
    </div>
    <div className={style.columns.items}>
      {tableColumns.map((column) => {
        return <RowColumnControl
          columns={columnKeys} visibleColumns={visibleColumns}
          key={column.key} column={column} orders={orders} wheres={wheres}
          setQuery={setQuery} query={query}
        />
      })}
    </div>
  </div>
}

function OperatorSelect(props) {
  return <select {...props}>
    <option value="eq">Eq</option>
    <option value="neq">Neq</option>
    <option value="gt">Gt</option>
    <option value="gte">Gte</option>
    <option value="lt">Lt</option>
    <option value="lte">Lte</option>
    <option value="like">Like</option>
  </select>
}

function SortSelect(props) {
  return <select {...props}>
    <option value="">None</option>
    <option value="desc">Desc</option>
    <option value="asc">Asc</option>
  </select>
}

function RowColumnControl(props) {
  const { columns, visibleColumns, column, orders, wheres, query, setQuery } = props

  const { t } = useLang()

  const [sort, setSort] = useState(orders[column.key] || ``)
  const [filterOp, setFilterOp] = useState(() => {
    const filter = wheres[column.key]
    if (filter) return filter.op
    return `eq`
  })
  const [filterValue, setFilterValue] = useState(() => {
    const filter = wheres[column.key]
    if (filter) return filter.value
    return ``
  })

  const visible = useMemo(() => {
    if (query.columns == null) return true
    return visibleColumns.indexOf(column.key) !== -1
  }, [query, visibleColumns, column.key])

  const onVisibleChange = useCallback((e) => {
    let newColumns = []
    if (query.columns == null) newColumns = [...columns]
    else newColumns = [...visibleColumns]

    if (e.target.checked) {
      newColumns = [...newColumns, column.key]
    } else {
      newColumns = newColumns.filter((key) => key !== column.key)
    }

    setQuery({ ...query, columns: newColumns.join(`,`) })
  }, [columns, visibleColumns, column.key, query])

  const update = useCallback(({ sort, filterOp, filterValue }) => {
    const newWheres = Object.assign({}, wheres)
    if (filterValue) {
      newWheres[column.key] = { op: filterOp, value: filterValue }
    } else {
      Reflect.deleteProperty(newWheres, column.key)
    }

    const newOrders = Object.assign({}, orders)
    if (sort) {
      newOrders[column.key] = sort
    } else {
      Reflect.deleteProperty(newOrders, column.key)
    }

    let newQuery = Object.assign({}, query)
    newQuery.refetch = Date.now()
    const qWheres = [], qOrders = []

    Object.keys(newWheres).forEach((key) => {
      const where = newWheres[key]
      qWheres.push(`${key}::${where.op}::${where.value}`)
    })

    Object.keys(newOrders).forEach((key) => {
      const order = newOrders[key]
      qOrders.push(`${key}::${order}`)
    })

    if (qWheres.length > 0) {
      newQuery.where = qWheres
    } else {
      Reflect.deleteProperty(newQuery, `where`)
    }

    if (qOrders.length > 0) {
      newQuery.order = qOrders
    } else {
      Reflect.deleteProperty(newQuery, `order`)
    }

    setQuery(newQuery)
  }, [column, wheres, orders, query])

  const apply = useCallback(() => {
    update({ sort, filterOp, filterValue })
  }, [update, sort, filterOp, filterValue])

  const reset = useCallback(() => {
    setSort('')
    setFilterOp('eq')
    setFilterValue('')
    update({ sort: ``, filterOp: `eq`, filterValue: `` })
  }, [update])

  return <div className={style.columns.item}>
    <div className={style.columns.row}>
      <div>{column.title}</div>
    </div>
    <div className={style.columns.row}>
      <div>
        <div>{t(`Visible:`)}</div>
        <input type="checkbox" checked={visible} onChange={onVisibleChange} />
      </div>
      <div>
        <div>{t(`Sort:`)}</div>
        <SortSelect value={sort} onChange={(e) => setSort(e.target.value)} />
      </div>
    </div>
    <div className={style.columns.row}>
      <div>{t(`Filter:`)}</div>
      <OperatorSelect value={filterOp} onChange={(e) => setFilterOp(e.target.value)} />
      <input type="text" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} />
    </div>
    <div className={style.columns.row}>
      <button onClick={reset}>{t(`Reset`)}</button>
      <button onClick={apply}>{t(`Apply`)}</button>
    </div>
  </div>
}

export default Controls
