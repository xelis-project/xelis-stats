import { Outlet, useLocation } from 'react-router'
import { useLang } from 'g45-react/hooks/useLang'
import { useMemo, useRef } from 'react'
import Icon from 'g45-react/components/fontawesome_icon'
import Footer from 'xelis-explorer/src/layout/footer'
import Header from 'xelis-explorer/src/layout/header'
import Background from 'xelis-explorer/src/layout/background'
import { css } from 'goober'
import layoutStyle from 'xelis-explorer/src/style/layout'

import packageJSON from '../../package.json'

const style = {
  header: css`
    padding: 2em 0 1em 0;
  `,
}

function Layout() {
  const location = useLocation()
  const firstLocation = useRef(location)
  const firstLoad = firstLocation.key === location.key

  const { t } = useLang()

  const links = useMemo(() => {
    return [
      { path: `/`, title: t(`Dashboard`), icon: <Icon name="dashboard" /> },
      { path: `/views`, title: t(`Database`), icon: <Icon name="database" /> },
      { path: `/mining`, title: t(`Mining Stats`), icon: <Icon name="chart-simple" /> },
    ]
  }, [t])

  const footerProps = useMemo(() => {
    return {
      title: t('XELIS Statistics'),
      description: t(`This tool offers comprehensive stats of the XELIS network. It has plenty of resources for investors and enthusiasts to track activity and performance. The information is directly pulled from nodes and indexed to display insightful charts, trends and the overall network health.`),
      version: `v${packageJSON.version}`,
      links: [
        { href: `https://xelis.io`, title: t('Home'), icon: <Icon name="home" /> },
        { href: EXPLORER_LINK, title: t('Explorer'), icon: <Icon name="window-maximize" /> },
        { href: `https://docs.xelis.io`, title: t('Documentation'), icon: <Icon name="book" /> },
        { href: `https://github.com/xelis-project`, title: `GitHub`, icon: <Icon name="github" type="brands" /> },
        { href: `https://discord.gg/z543umPUdj`, title: `Discord`, icon: <Icon name="discord" type="brands" /> },
      ],
      pages: links
    }
  }, [t])

  return <div className={layoutStyle.container}>
    <Background />
    <div className={layoutStyle.pageFlex}>
      <div className={layoutStyle.pageMaxWidth}>
        <Header title={t(`Statistics`)} links={links} className={style.header} />
        <div data-opacity={firstLoad} key={location.key}> {/* Keep location key to re-trigger page transition animation */}
          <Outlet />
        </div>
      </div>
      <Footer {...footerProps} />
    </div>
  </div>
}

export default Layout
