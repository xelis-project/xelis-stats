import { useCallback, useState, useMemo, cloneElement } from 'react'
import { css } from 'goober'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import { saveAs } from 'file-saver'
import OffCanvas from 'xelis-explorer/src/components/offCanvas'
import Icon from 'g45-react/components/fontawesome_icon'
import { useLang } from 'g45-react/hooks/useLang'
import Button from 'xelis-explorer/src/components/button'
import { scaleOnHover } from 'xelis-explorer/src/style/animate'
import theme from 'xelis-explorer/src/style/theme'
import { useNavigate } from 'react-router-dom'

const style = {
  container: css`
    padding: 1em;
    display: flex;
    flex-direction: column;
    gap: 1em;
    overflow-y: auto;

    > :nth-child(1) {
      display: flex;
      justify-content: space-between;
      align-items: center;

      > :nth-child(1) {
        font-weight: bold;
        font-size: 1.5em;
      }

      button {
        border: none;
        background-color: var(--text-color);
        color: var(--bg-color);
        border-radius: 50%;
        height: 40px;
        width: 40px;
        font-size: 1em;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: .25s transform;

        &:hover {
          transform: scale(0.9);
        }

        ${theme.query.minLarge} {
          display: none;
        }
      }
    }

    > :nth-child(2) {
      display: flex;
      gap: .5em;
      align-items: center;

      button {
        padding: .5em 1em;
        border-radius: .5em;
        border: none;
        background: var(--text-color);
        color: var(--bg-color);
        display: flex;
        align-items: center;
        cursor: pointer;
        white-space: nowrap;
        gap: .5em;
        ${scaleOnHover()}
      }
    }

    > :nth-child(3) {
      display: flex;
      flex-direction: column;
      gap: 1em;

      > div {
        display: flex;
        gap: .5em;
        flex-direction: column;

        > :nth-child(1) {
          font-size: 1.1em;
          opacity: .8;
        }  
      }
    }
  `,
  columnList: css`
    > :nth-child(2) {
      display: flex;
      gap: .25em;
      align-items: center;
      user-select: none;
    }

    > :nth-child(3) {
      display: flex;
      gap: .5em;
      flex-direction: column;

      > div {
        display: flex;
        gap: .5em;
        align-items: center;
        padding: .5em;
        border-radius: .5em;
        border: thin solid var(--text-color);
        color: var(--text-color);
        background: var(--table-td-bg-color);
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
      }
    }
  `
}

function useControls(props) {
  const { sources, source, dataSource, query, setQuery, list, chartColumn } = props
  const { t } = useLang()

  const [opened, setOpened] = useState(false)
  const navigate = useNavigate()

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
      const { views } = column
      if (query.chart_view === `candlestick` && !column.candle) return false
      if (Array.isArray(views) && views.indexOf(query.chart_view) === -1) return false
      return true
    })

    return columns.map((column) => ({ key: column.key, text: column.title }))
  }, [source, query.chart_view])

  const clipShareLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
  }, [])

  const exportData = useCallback(() => {
    const dataFile = new File([JSON.stringify(list, null, 2)], "chart_data.json", { type: "text/plain;charset=utf-8" })
    saveAs(dataFile)
  }, [list])

  const clipChart = useCallback(() => {
    if (chartRef.current) {
      const screenshot = chartRef.current.takeScreenshot()
      screenshot.toBlob((blob) => {
        navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob
          })
        ])
      })
    }
  }, [])

  const render = <OffCanvas maxWidth={500} position="right" opened={opened} className={style.container}>
    <div>
      <div>{t(`Controls`)}</div>
      <button onClick={() => setOpened(false)}><Icon name="close" /></button>
    </div>
    <div>
      <Button icon="link" onClick={clipShareLink}>{t(`Clip Link`)}</Button>
      {query.view !== `table` && <Button icon="clipboard" onClick={clipChart}>{t(`Clip Chart`)}</Button>}
      <Button icon="file-arrow-down" onClick={exportData}>{t(`Export`)}</Button>
    </div>
    <div>
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
          <div>{t(`Key`)}</div>
          <Dropdown items={chartColumns} value={query.chart_key} onChange={(item) => {
            setQuery({ ...query, chart_key: item.key })
          }} />
          <MinMaxCheckbox query={query} setQuery={setQuery} />
        </div>
      </>}
      {query.view === `table` && <TableColumns source={source} query={query} setQuery={setQuery} />}
    </div>
  </OffCanvas>

  const topTitle = useMemo(() => {
    let text = source.title
    if (query.range) {
      // todo
    }
    return text
  }, [source, query])

  const bottomTitle = useMemo(() => {
    if (query.view === `table`) return t(`Table`)
    return chartColumn ? `${chartColumn.title}` : `--`
  }, [query, chartColumn])

  const tab = <div>
    <div>
      <div>{topTitle}</div>
      <div>{bottomTitle}</div>
    </div>
    <Button icon="window-maximize" iconProps={{ type: 'regular', className: 'fa-rotate-90' }} onClick={() => setOpened(!opened)} />
  </div>

  return { tab, render, opened, setOpened }
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

  const toggleAll = useCallback((e) => {
    if (e.target.checked) {
      const newQuery = Object.assign({}, query)
      Reflect.deleteProperty(newQuery, `columns`)
      setQuery(newQuery)
    } else {
      setQuery({ ...query, columns: `` })
    }
  }, [query])

  const checkedColumns = useMemo(() => {
    if (!query.columns) return []
    return query.columns.split(`,`)
  }, [query])

  const columnKeys = useMemo(() => {
    return tableColumns.map(column => column.key)
  }, [tableColumns])

  return <div className={style.columnList}>
    <div>Columns ({tableColumns.length})</div>
    <div>
      <input type="checkbox" checked={query.columns === undefined} onChange={toggleAll} />
      <div>{t(`Select All`)}</div>
    </div>
    <div>
      {tableColumns.map((column) => {
        return <RowColumnCheckbox
          columns={columnKeys} checkedColumns={checkedColumns}
          key={column.key} column={column}
          setQuery={setQuery} query={query}
        />
      })}
    </div>
  </div>
}

function RowColumnCheckbox(props) {
  const { columns, checkedColumns, column, query, setQuery } = props
  const { key, title } = column

  const checked = useMemo(() => {
    if (query.columns === undefined) return true
    return checkedColumns.indexOf(key) !== -1
  }, [query, checkedColumns, key])

  const onChange = useCallback((e) => {
    let newColumns = []
    if (query.columns === undefined) newColumns = [...columns]
    else newColumns = [...checkedColumns]

    if (e.target.checked) {
      newColumns = [...newColumns, key]
    } else {
      newColumns = newColumns.filter((column) => column !== key)
    }

    setQuery({ ...query, columns: newColumns.join(`,`) })
  }, [columns, checkedColumns, key, query])

  const onClick = useCallback((e) => {
    if (e.target.children[0]) e.target.children[0].click()
  }, [])

  return <div key={key} onClick={onClick} data-checked={checked}>
    <input type="checkbox" checked={checked} onChange={onChange} />{title}
  </div>
}

export default useControls
