import { Outlet, useLocation } from 'react-router'
import { css } from 'goober'
import { useLang } from 'g45-react/hooks/useLang'
import { useMemo, useRef } from 'react'
import Icon from 'g45-react/components/fontawesome_icon'
import theme from 'xelis-explorer/src/style/theme'
import { opacity } from 'xelis-explorer/src/style/animate'
import Footer from 'xelis-explorer/src/layout/footer'
import Menu from 'xelis-explorer/src/layout/menu'
import Header from 'xelis-explorer/src/layout/header'

import packageJSON from '../../package.json'

export const style = {
  background: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image: ${theme.apply({ xelis: `url('public/img/bg_xelis.jpg')`, dark: `url('public/img/bg_xelis_dark.jpg')`, light: `url('public/img/bg_xelis_light.jpg')` })};
    background-repeat: no-repeat;
    background-size: cover;
    background-position: top center;
    z-index: -1;
  `,
  container: css`
    position: relative;
    height: 100%;

    .layout-max-width {
      margin: 0 auto;
      max-width: 1000px;
      width: 100%;
      padding: 0 1em;

      ${theme.query.minMobile} {
        padding: 0 2em;
      }

      ${theme.query.minLarge} {
        max-width: 1400px;
      }
    }
  `,
  layoutFlex: css`
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 100%;

    [data-opacity="true"] {
      ${opacity()}
    }
  `
}

function Layout() {
  const location = useLocation()
  const firstLocation = useRef(location)
  const firstLoad = firstLocation.key === location.key

  const { t } = useLang()

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
      pages: [
        { link: `/`, title: t('Dashboard') },
        { link: `/database`, title: t(`Database`) },
      ]
    }
  }, [t])

  const links = useMemo(() => {
    return [
      { path: `/`, title: t(`Dashboard`), icon: <Icon name="dashboard" /> },
      { path: `/database`, title: t(`Database`), icon: <Icon name="database" /> },
    ]
  }, [t])

  return <>
    <div className={style.background} />
    <div className={style.container}>
      <div className={style.layoutFlex}>
        <div className="layout-max-width">
          <Header title={t(`Statistics`)} menu={<Menu links={links} />} />
          <div data-opacity={firstLoad} key={location.key}> {/* Keep location key to re-trigger page transition animation */}
            <Outlet />
          </div>
        </div>
        <Footer {...footerProps} />
      </div>
    </div>
  </>
}

export default Layout
