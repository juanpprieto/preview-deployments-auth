import {useLoaderData, Link} from 'react-router';
import type {Route} from './+types/_index';
import {Image} from '@shopify/hydrogen';
import type {FeaturedCollectionFragment} from 'storefrontapi.generated';
import {Query} from 'hydrogen-sanity';

const HOME_PAGE_QUERY = `*[_type == "marketingPage" && slug.current == "home"][0]{
  _id,
  title,
  "slug": slug.current,
  sections[]{
    _type,
    _key,
    title,
    headlineText
  }
}`;

type HomePage = {
  _id: string;
  title: string;
  slug: string;
  sections: Array<{
    _type: string;
    _key: string;
    title: string;
    headlineText?: Array<{
      _type: string;
      children: Array<{text: string}>;
    }>;
  }>;
} | null;

export const meta: Route.MetaFunction = () => {
  return [{title: 'Hydrogen | Home'}];
};

export async function loader(args: Route.LoaderArgs) {
  const deferredData = loadDeferredData(args);
  const criticalData = await loadCriticalData(args);

  return {...deferredData, ...criticalData};
}

async function loadCriticalData({context}: Route.LoaderArgs) {
  const [{collections}, homePage] = await Promise.all([
    context.storefront.query(FEATURED_COLLECTION_QUERY),
    context.sanity.query<HomePage>(HOME_PAGE_QUERY),
  ]);

  return {
    featuredCollection: collections.nodes[0],
    homePage,
  };
}

function loadDeferredData({context}: Route.LoaderArgs) {
  const recommendedProducts = context.storefront
    .query(RECOMMENDED_PRODUCTS_QUERY)
    .catch((error: Error) => {
      console.error(error);
      return null;
    });

  return {
    recommendedProducts,
  };
}

function extractText(
  blocks?: Array<{children: Array<{text: string}>}>,
): string {
  if (!blocks || !Array.isArray(blocks)) return '';
  return blocks
    .flatMap((block) => block.children.map((child) => child.text))
    .join(' ');
}

export default function Homepage() {
  const data = useLoaderData<typeof loader>();
  return (
    <div className="home">
      <SanityHomePage initial={data.homePage} />
      <FeaturedCollection collection={data.featuredCollection} />
      {/* <RecommendedProducts products={data.recommendedProducts} /> */}
    </div>
  );
}

function SanityHomePage({initial}: {initial: typeof Query extends never ? never : any}) {
  return (
    <Query query={HOME_PAGE_QUERY} options={{initial}}>
      {(homePage: HomePage) => {
        if (!homePage) return null;
        return (
          <section
            style={{
              padding: '2rem',
              background: '#f5f5f5',
              marginBottom: '2rem',
            }}
          >
            <p style={{fontSize: '0.75rem', color: '#999', marginBottom: '0.5rem'}}>
              Sanity Content (live editing enabled)
            </p>
            <h2 style={{fontSize: '1.5rem', fontWeight: 'bold'}}>
              {homePage.title}
            </h2>
            {homePage.sections?.map((section) => (
              <div key={section._key} style={{marginTop: '1rem'}}>
                <span
                  style={{
                    fontSize: '0.7rem',
                    background: '#e0e0e0',
                    padding: '0.15rem 0.4rem',
                    borderRadius: '3px',
                    marginRight: '0.5rem',
                  }}
                >
                  {section._type}
                </span>
                <strong>{section.title}</strong>
                {section.headlineText && (
                  <p style={{marginTop: '0.25rem', color: '#555'}}>
                    {extractText(section.headlineText)}
                  </p>
                )}
              </div>
            ))}
          </section>
        );
      }}
    </Query>
  );
}

function FeaturedCollection({
  collection,
}: {
  collection: FeaturedCollectionFragment;
}) {
  if (!collection) return null;
  const image = collection?.image;
  return (
    <Link
      className="featured-collection"
      to={`/collections/${collection.handle}`}
    >
      {image && (
        <div className="featured-collection-image">
          <Image data={image} sizes="100vw" />
        </div>
      )}
      <h1>{collection.title}</h1>
    </Link>
  );
}

// Commented out for staging differentiation test — staging shows only
// Sanity content + featured collection, while production keeps full layout.
// function RecommendedProducts({
//   products,
// }: {
//   products: Promise<RecommendedProductsQuery | null>;
// }) {
//   return (
//     <div className="recommended-products">
//       <h2>Recommended Products</h2>
//       <Suspense fallback={<div>Loading...</div>}>
//         <Await resolve={products}>
//           {(response) => (
//             <div className="recommended-products-grid">
//               {response
//                 ? response.products.nodes.map((product) => (
//                     <ProductItem key={product.id} product={product} />
//                   ))
//                 : null}
//             </div>
//           )}
//         </Await>
//       </Suspense>
//       <br />
//     </div>
//   );
// }

const FEATURED_COLLECTION_QUERY = `#graphql
  fragment FeaturedCollection on Collection {
    id
    title
    image {
      id
      url
      altText
      width
      height
    }
    handle
  }
  query FeaturedCollection($country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    collections(first: 1, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        ...FeaturedCollection
      }
    }
  }
` as const;

const RECOMMENDED_PRODUCTS_QUERY = `#graphql
  fragment RecommendedProduct on Product {
    id
    title
    handle
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    featuredImage {
      id
      url
      altText
      width
      height
    }
  }
  query RecommendedProducts ($country: CountryCode, $language: LanguageCode)
    @inContext(country: $country, language: $language) {
    products(first: 4, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        ...RecommendedProduct
      }
    }
  }
` as const;
