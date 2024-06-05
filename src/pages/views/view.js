import { useCallback, useEffect, useState, useMemo } from 'react'
import { css, glob } from 'goober'
import { ColorType, LineStyle, createChart } from 'lightweight-charts'
import { useRef } from 'react'
import theme from 'xelis-explorer/src/style/theme'
import { useLang } from 'g45-react/hooks/useLang'
import TableFlex from 'xelis-explorer/src/components/tableFlex'
import { Helmet } from 'react-helmet-async'
import useQueryString from 'g45-react/hooks/useQueryString'
import { useParams } from 'react-router-dom'
import Icon from 'g45-react/components/fontawesome_icon'
import useTheme from 'xelis-explorer/src/hooks/useTheme'
import to from 'await-to-js'

import useControls from './controls'
import useSources from './sources'
import style from './style'

// This makes sure controls panel is always open if screen is larger
glob`
  body[data-layout="stats"] {
    ${theme.query.minLarge} {
      .layout-max-width {
        margin: 0 490px 0 0 !important;
        max-width: inherit !important;
        width: inherit !important;
      }
  
      [data-open="false"] {
        translate: 0 !important;
        opacity: 1 !important;
        transition: none !important;
      }
    }
  }
`

function ViewStats(props) {
  const { dataSource } = useParams()

  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  //const [count, setCount] = useState()
  const [err, setErr] = useState()
  const { t } = useLang()

  const [query, setQuery] = useQueryString({ view: `table` })
  const { theme: currentTheme } = useTheme()

  const sources = useSources()
  const source = useMemo(() => {
    return sources.find((s) => s.key === dataSource) || {}
  }, [dataSource])

  const load = useCallback(async () => {
    if (typeof source.getData !== `function`) return
    setList([])
    setLoading(true)

    const resErr = (err) => {
      setLoading(false)
      setErr(err)
    }

    const [err, data] = await to(source.getData(query))
    if (err) return resErr(err)

    //setCount(count)
    setList(data.rows)
    setLoading(false)
    setErr(null)
  }, [source.getData, query.refetch])

  useEffect(() => {
    load()
  }, [load])

  const chartDivRef = useRef()
  const chartRef = useRef()
  const seriesRef = useRef()
  const minLineRef = useRef()
  const maxLineRef = useRef()
  const seriesBottomRef = useRef()

  const chartColumn = useMemo(() => {
    return (source.columns || []).find((column) => column.key === query.chart_key)
  }, [source, query])

  const controls = useControls({ sources, source, dataSource, query, setQuery, list, chartRef })

  // load trading view chart
  useEffect(() => {
    if (chartRef.current && seriesRef.current) {
      chartRef.current.removeSeries(seriesRef.current)
      seriesRef.current = null
    }

    if (!chartColumn) return

    const options = {
      layout: {
        textColor: currentTheme === `light` ? 'black' : 'white',
        background: { type: ColorType.Solid, color: currentTheme === `light` ? 'rgb(255 255 255 / 50%)' : 'rgb(0 0 0 / 50%)' }
      },
      autoSize: true,
      grid: {
        horzLines: {
          color: currentTheme === `light` ? 'rgb(0 0 0 / 10%)' : 'rgb(255 255 255 / 10%)',
          style: LineStyle.Dashed
        },
        vertLines: {
          color: currentTheme === `light` ? 'rgb(0 0 0 / 10%)' : 'rgb(255 255 255 / 10%)',
          style: LineStyle.Dashed
        }
      },
      crosshair: {
        horzLine: {
          color: currentTheme === `light` ? 'rgb(0 0 0 / 30%)' : 'rgb(255 255 255 / 30%)',
        },
        vertLine: {
          color: currentTheme === `light` ? 'rgb(0 0 0 / 30%)' : 'rgb(255 255 255 / 30%)',
        }
      },
      timeScale: {
        timeVisible: true,
        minBarSpacing: 6,
        //tickMarkFormatter: source.timeFormatter || (p => null), // null func is important or it won't change if we use a source that doesn't have timeFormatter defined
      },
      localization: {
        priceFormatter: chartColumn.format,
        //timeFormatter: source.timeFormatter || (p => null),
      }
    }

    if (!chartRef.current) {
      chartRef.current = createChart(chartDivRef.current, options)
    }

    switch (query.chart_view) {
      case `area`:
        seriesRef.current = chartRef.current.addAreaSeries()
        break
      case `candlestick`:
        seriesRef.current = chartRef.current.addCandlestickSeries()
        break
      case `histogram`:
        seriesRef.current = chartRef.current.addHistogramSeries()
        break
      case `line`:
        seriesRef.current = chartRef.current.addLineSeries()
        break
    }

    chartRef.current.applyOptions(options)
  }, [source, chartColumn, query.chart_view, currentTheme])

  // load data in trading view chart
  useEffect(() => {
    if (!chartRef.current) return
    if (seriesBottomRef.current) {
      chartRef.current.removeSeries(seriesBottomRef.current)
      seriesBottomRef.current = null
    }
    if (!seriesRef.current) return
    if (!chartColumn) return

    const data = []
    const bottomData = []
    let minValue, maxValue
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      let time = null
      if (typeof source.rowKey === `function`) time = source.rowKey(item, i)
      else time = item[source.rowKey]

      if (time == null) return

      if (chartColumn.bottomChartKey) bottomData.push({ time, value: item[chartColumn.bottomChartKey] })
      if (query.chart_view === `candlestick`) {
        if (chartColumn.candle) {
          const { lowKey, highKey, openKey, closeKey } = chartColumn.candle

          if (!minValue) minValue = item[lowKey]
          if (!maxValue) maxValue = item[highKey]
          if (item[lowKey] < minValue) minValue = item[lowKey]
          if (item[highKey] > maxValue) maxValue = item[highKey]

          data.push({ time, low: item[lowKey], high: item[highKey], open: item[openKey], close: item[closeKey] })
        }
      } else {
        let value = null
        if (typeof chartColumn.rowKey === `function`) value = chartColumn.rowKey(item, i)
        else value = item[chartColumn.key]

        if (!minValue) minValue = value
        if (!maxValue) maxValue = value
        if (value < minValue) minValue = value
        if (value > maxValue) maxValue = value

        data.push({ time, value })
      }
    }

    const minLine = {
      price: minValue,
      color: '#ef5350',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'min',
    }

    const maxLine = {
      price: maxValue,
      color: '#26a69a',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'max',
    }

    if (minLineRef.current) seriesRef.current.removePriceLine(minLineRef.current)
    if (maxLineRef.current) seriesRef.current.removePriceLine(maxLineRef.current)

    if (query.min_max !== `false` && data.length > 0) {
      minLineRef.current = seriesRef.current.createPriceLine(minLine)
      maxLineRef.current = seriesRef.current.createPriceLine(maxLine)
    }

    // make sure the data is always ascending ordering
    // https://stackoverflow.com/questions/65408588/lightweight-charts-uncaught-error-value-is-null
    data.sort((a, b) => a.time - b.time)

    seriesRef.current.setData(data)

    if (chartColumn.bottomChartKey) {
      const options = {
        color: `yellow`,
        priceFormat: {
          type: 'volume',
        },
        priceScaleId: ''
      }

      seriesBottomRef.current = chartRef.current.addHistogramSeries(options)
      seriesBottomRef.current.priceScale().applyOptions({
        scaleMargins: {
          top: 0.8,
          bottom: 0,
        }
      })

      bottomData.sort((a, b) => a.time - b.time)
      seriesBottomRef.current.setData(bottomData)
    }

    chartRef.current.timeScale().fitContent()
  }, [list, chartColumn, query.chart_view, query.min_max, currentTheme])

  useEffect(() => {
    /*window.setInterval(() => {
      if (!areaSeriesRef.current) return
      areaSeriesRef.current.update({
        
        time: Date.now() / 1000,
        value: Math.random() * 100000
      })
    }, 1000)*/
  }, [])

  const tableHeaders = useMemo(() => {
    if (loading) return

    const visibleColumns = (query.columns || ``).split(`,`)
    const columns = (source.columns || []).filter((column) => {
      if (column.candle) return false
      if (query.columns == null) return true
      return visibleColumns.indexOf(column.key) !== -1
    })

    return columns.map((column) => {
      return {
        key: column.key,
        title: column.title,
        render: (value, item) => {
          if (typeof column.format === `function`) {
            const newValue = value != null ? value : ``
            return column.format(newValue, item)
          }

          return value
        }
      }
    })
  }, [source, loading, query])

  return <div>
    <Helmet bodyAttributes={{ [`data-layout`]: `stats` }}>
      <title>{source.title}</title>
    </Helmet>
    {controls.tab}
    <div className={style.chart.container} ref={chartDivRef} style={{ display: query.view === `chart` ? `block` : `none` }}>
      <div className={style.chart.trademark}>
        <a href="https://tradingview.github.io/lightweight-charts/">Powered by Lightweight Charts™</a>
      </div>
      {loading && <div className={style.chart.loading}>
        <Icon name="circle-notch" className="fa-spin" />
      </div>}
      {(!loading && list.length === 0) && <div className={style.chart.loading}>
        NO DATA
      </div>}
    </div>
    <div style={{ display: query.view === `table` ? `block` : `none` }}>
      <TableFlex data={list} rowKey={(_, i) => i} err={err} loading={loading} emptyText={t('No data')}
        headers={tableHeaders} keepTableDisplay mobileFormat={false}
      />
    </div>
    {controls.render}
  </div >
}

export default ViewStats
